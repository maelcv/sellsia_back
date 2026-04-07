/**
 * Client API Sellsy v2 — Récupère les données CRM pour enrichir le contexte des agents.
 */

const SELLSY_API_BASE = "https://api.sellsy.com/v2";

function unwrapItem(payload) {
  if (payload && typeof payload === "object" && payload.data && !Array.isArray(payload.data)) {
    return payload.data;
  }
  return payload;
}

function normalizeAmount(amount) {
  if (amount == null) return null;
  if (typeof amount === "number") return amount;
  if (typeof amount === "string") {
    const parsed = Number(amount);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof amount === "object") {
    const parsed = Number(amount.value ?? amount.amount ?? amount.total ?? amount.total_incl_tax);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeCurrency(amount) {
  if (!amount || typeof amount !== "object") return null;
  return amount.currency || amount.currency_code || null;
}

function normalizeEstimateTotal(estimate) {
  if (!estimate || typeof estimate !== "object") return null;
  if (estimate.total_amount != null) return normalizeAmount(estimate.total_amount);
  if (estimate.amounts && typeof estimate.amounts === "object") {
    return normalizeAmount(
      estimate.amounts.total_incl_tax ??
      estimate.amounts.total_incl ??
      estimate.amounts.total ??
      estimate.amounts.total_without_tax
    );
  }
  return null;
}

export class SellsyClient {
  constructor(credentials) {
    this.credentials = credentials;
    if (credentials.type === "token") {
      this._accessToken = credentials.token;
      this._tokenExpiry = Number.MAX_SAFE_INTEGER;
    } else {
      this._accessToken = credentials.accessToken || credentials.access_token || null;
      // If expiry is unknown but access token exists, assume short-lived validity window.
      this._tokenExpiry = this._accessToken ? Date.now() + 50 * 60 * 1000 : 0;
    }
  }

  /**
   * Obtient un access token (cache pour OAuth, direct pour token).
   */
  async getAccessToken() {
    if (this.credentials.type === "token") {
      return this.credentials.token;
    }

    // OAuth via stored access_token + refresh_token (authorization_code flow result).
    // Sellsy does NOT support client_credentials grant. Tokens must be obtained via
    // the authorization_code flow and stored as accessToken + refreshToken.
    if (this._accessToken && Date.now() < this._tokenExpiry) {
      return this._accessToken;
    }

    const refreshToken = this.credentials.refreshToken || this.credentials.refresh_token;
    // If we only have an access token (no refresh token), try using it as-is.
    if (!refreshToken && this._accessToken) {
      return this._accessToken;
    }

    // Legacy fallback: some Sellsy setups use client_id/client_secret as direct credentials
    // and rely on client_credentials grant.
    if (!refreshToken && this.credentials.clientId && this.credentials.clientSecret) {
      const clientCredentialsResponse = await fetch("https://login.sellsy.com/oauth2/access-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: this.credentials.clientId,
          client_secret: this.credentials.clientSecret,
        }),
      });

      if (clientCredentialsResponse.ok) {
        const data = await clientCredentialsResponse.json();
        this._accessToken = data.access_token;
        this._tokenExpiry = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
        return this._accessToken;
      }
    }

    if (!refreshToken) {
      throw new Error(
        "Sellsy OAuth: no refresh token available. " +
        "Please reconnect your Sellsy account using a Personal Access Token (PAT) " +
        "generated in Sellsy → Settings → Security → API Tokens."
      );
    }

    // Refresh the access token using the stored refresh token
    const response = await fetch("https://login.sellsy.com/oauth2/access-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
        refresh_token: refreshToken
      })
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      const errMsg = errBody?.error_description || errBody?.error || response.status;
      throw new Error(`Sellsy OAuth token refresh failed (${errMsg}). Please reconnect your Sellsy account.`);
    }

    const data = await response.json();
    this._accessToken = data.access_token;
    this._tokenExpiry = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
    this.credentials.accessToken = data.access_token;
    // Update stored refresh token if a new one was issued
    if (data.refresh_token) {
      this.credentials.refreshToken = data.refresh_token;
    }
    return this._accessToken;
  }

  /**
   * Requête API Sellsy générique.
   */
  async request(path, options = {}) {
    const token = await this.getAccessToken();
    const response = await fetch(`${SELLSY_API_BASE}${path}`, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...options.headers
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      // Sellsy error format: { "error": { "code": N, "message": "...", "context": "..." } }
      const errObj = err.error && typeof err.error === "object" ? err.error : null;
      const errMsg = errObj?.message || (typeof err.error === "string" ? err.error : null) || err.message || JSON.stringify(err) || "Unknown";
      throw new Error(`Sellsy API ${response.status}: ${errMsg}`);
    }

    return response.json();
  }

  // ── Sociétés / Companies ──

  async getCompany(id) {
    // If the ID is not numeric, it might be a company name — try to search first.
    if (typeof id === "string" && !/^\d+$/.test(id)) {
      try {
        const results = await this.searchCompanies(id, 1);
        if (results && results.length > 0) {
          return await this.getCompany(results[0].id);
        }
      } catch (err) {
        console.warn(`[SellsyClient] Failed to resolve company name ${id}:`, err.message);
      }
    }
    const company = unwrapItem(await this.request(`/companies/${id}`));
    return {
      id: company.id,
      name: company.name,
      email: company.email,
      phone: company.phone_number,
      website: company.website,
      address: company.address,
      note: company.note,
      type: company.type,
      siret: company.siret,
      capital: company.capital,
      mainContactId: company.main_contact_id || null,
      dunningContactId: company.dunning_contact_id || null,
      invoicingContactId: company.invoicing_contact_id || null,
      createdAt: company.created,
      updatedAt: company.updated,
      raw: company
    };
  }

  async searchCompanies(query, limit = 5) {
    const data = await this.request("/companies/search", {
      method: "POST",
      body: {
        filters: { search: query },
        limit,
        order: [{ direction: "desc", field: "updated" }]
      }
    });
    return data.data || [];
  }

  // ── Contacts ──

  async getContact(id) {
    // If the ID looks like an email or is not numeric
    if (typeof id === "string" && (id.includes("@") || !/^\d+$/.test(id))) {
      try {
        const results = await this.searchContacts(id, 1);
        if (results && results.length > 0) {
          return await this.getContact(results[0].id);
        }
      } catch (err) {
        console.warn(`[SellsyClient] Failed to resolve contact ${id}:`, err.message);
      }
    }
    const contact = unwrapItem(await this.request(`/contacts/${id}`));
    return {
      id: contact.id,
      firstName: contact.first_name,
      lastName: contact.last_name,
      fullName: `${contact.first_name || ""} ${contact.last_name || ""}`.trim(),
      email: contact.email,
      phone: contact.phone_number,
      mobile: contact.mobile_number,
      position: contact.position,
      note: contact.note,
      createdAt: contact.created,
      raw: contact
    };
  }

  // ── Opportunités / Deals ──

  async getOpportunity(id) {
    // If the ID looks like an opportunity number (e.g., "OPP-00078", "OPP-12345")
    // or contains a dash (typical of numeric references in business), try to search for it first.
    if (typeof id === "string" && (id.toUpperCase().startsWith("OPP-") || (id.includes("-") && id.length > 3))) {
      try {
             const results = await this.getOpportunities({ search: id }, 1);
             if (results && results.length > 0) {
               // Prefer exact number match if multiple results come back from search
               const exact = results.find(o => String(o.number).toUpperCase() === id.toUpperCase()) || results[0];
               // If we found it, return the full object (re-fetching by numeric ID ensures full detail if search was shallow)
               if (exact && exact.id) {
                 return await this.getOpportunity(exact.id);
               }
             }
      } catch (err) {
        console.warn(`[SellsyClient] Failed to resolve opportunity number ${id}:`, err.message);
      }
    }

    const response = await this.request(`/opportunities/${id}`);
    const opp = unwrapItem(response);
    return {
      id: opp.id,
      number: opp.number,
      name: opp.name,
      amount: normalizeAmount(opp.amount),
      currency: normalizeCurrency(opp.amount),
      probability: opp.probability,
      status: opp.status,
      step: opp.step,
      stepId: opp.step_id || opp.step?.id,
      pipeline: opp.pipeline,
      pipelineId: opp.pipeline?.id,
      source: opp.source,
      dueDate: opp.due_date,
      note: opp.note,
      companyId: opp.company_id,
      contactId: opp.contact_id || opp.contact_ids?.[0] || null,
      createdAt: opp.created,
      updatedAt: opp.updated || opp.updated_status,
      raw: opp
    };
  }

  async getOpportunities(filters = {}, limit = 25) {
    const data = await this.request("/opportunities/search", {
      method: "POST",
      body: {
        filters,
        limit,
        order: [{ direction: "desc", field: "updated" }]
      }
    });
    return (data.data || []).map((opp) => ({
      ...opp,
      amountValue: normalizeAmount(opp.amount),
      updatedAt: opp.updated || opp.updated_status || null
    }));
  }

  // ── Devis / Quotes ──

  async getQuote(id) {
    // If the ID looks like an estimate number (e.g., "EST-00078", "DEVIS-123")
    if (typeof id === "string" && (id.toUpperCase().startsWith("EST-") || id.toUpperCase().startsWith("DEVIS-") || (id.includes("-") && id.length > 3))) {
      try {
             const results = await this.getEstimates({ search: id }, 1);
             if (results && results.length > 0) {
               const exact = results.find(o => String(o.number).toUpperCase() === id.toUpperCase()) || results[0];
               if (exact && exact.id) {
                 return await this.getQuote(exact.id);
               }
             }
      } catch (err) {
        console.warn(`[SellsyClient] Failed to resolve quote number ${id}:`, err.message);
      }
    }

    const quote = unwrapItem(await this.request(`/estimates/${id}`));
    return {
      id: quote.id,
      number: quote.number,
      subject: quote.subject,
      status: quote.status,
      totalAmount: normalizeEstimateTotal(quote),
      currency: quote.currency || quote.amounts?.currency || null,
      companyId: quote.company_id || quote.related?.company_id || null,
      contactId: quote.contact_id,
      opportunityId: quote.related?.opportunity_id || quote.opportunity_id || null,
      validityDate: quote.validity_date,
      note: quote.note,
      createdAt: quote.created,
      raw: quote
    };
  }

  async getEstimates(filters = {}, limit = 25) {
    const data = await this.request("/estimates/search", {
      method: "POST",
      body: { filters, limit, order: [{ direction: "desc", field: "created" }] }
    });
    return data.data || [];
  }

  // ── Pipeline / Vue globale ──

  async getPipeline() {
    const pipelines = await this.request("/opportunities/pipelines");
    return pipelines.data || [];
  }

  async getPipelineSteps(pipelineId) {
    const steps = await this.request(`/opportunities/pipelines/${pipelineId}/steps`);
    return steps.data || [];
  }

  async getPipelineAnalysis() {
    try {
      const pipelines = await this.getPipeline();
      const analysis = [];

      for (const pipeline of pipelines.slice(0, 3)) {
        const steps = await this.getPipelineSteps(pipeline.id);
        const opps = await this.getOpportunities({ pipeline_id: pipeline.id }, 100);

        const stepSummary = {};
        for (const opp of opps) {
          const stepName = opp.step?.name || "Inconnu";
          const oppAmount = normalizeAmount(opp.amountValue ?? opp.amount) || 0;
          if (!stepSummary[stepName]) {
            stepSummary[stepName] = { count: 0, totalAmount: 0 };
          }
          stepSummary[stepName].count++;
          stepSummary[stepName].totalAmount += oppAmount;
        }

        analysis.push({
          pipelineName: pipeline.name,
          totalOpportunities: opps.length,
          totalAmount: opps.reduce((sum, o) => sum + (normalizeAmount(o.amountValue ?? o.amount) || 0), 0),
          stepBreakdown: stepSummary,
          staleOpportunities: opps.filter((o) => {
            const updated = new Date(o.updatedAt || o.updated || o.updated_status || 0);
            if (Number.isNaN(updated.getTime())) return false;
            const daysSince = (Date.now() - updated.getTime()) / (1000 * 60 * 60 * 24);
            return daysSince > 30;
          }).length
        });
      }

      return analysis;
    } catch (error) {
      return { error: error.message };
    }
  }

  // ── Activités ──

  async getActivities(entityType, entityId, limit = 20) {
    try {
      const typeMap = {
        company: "companies",
        contact: "contacts",
        opportunity: "opportunities"
      };
      const path = typeMap[entityType]
        ? `/${typeMap[entityType]}/${entityId}/activities?limit=${limit}`
        : `/activities?limit=${limit}`;

      const data = await this.request(path);
      return data.data || [];
    } catch {
      return [];
    }
  }

  // ── Write Operations ──

  async updateOpportunity(id, fields) {
    return unwrapItem(await this.request(`/opportunities/${id}`, {
      method: "PATCH",
      body: fields
    }));
  }

  async updateCompany(id, fields) {
    return unwrapItem(await this.request(`/companies/${id}`, {
      method: "PATCH",
      body: fields
    }));
  }

  async createNote(entityType, entityId, content) {
    // POST /activities — create a note linked to an entity
    const relatedTypeMap = { company: "company", contact: "contact", opportunity: "opportunity" };
    const relatedType = relatedTypeMap[entityType] || entityType;
    return await this.request("/activities", {
      method: "POST",
      body: {
        type: "note",
        description: content,
        related: [{ id: Number(entityId), type: relatedType }]
      }
    });
  }

  // ── Invoices (pour reporting) ──

  async getInvoices(filters = {}, limit = 25) {
    try {
      const data = await this.request("/invoices/search", {
        method: "POST",
        body: { filters, limit, order: [{ direction: "desc", field: "created" }] }
      });
      return data.data || [];
    } catch {
      return [];
    }
  }

  async getInvoice(id) {
    // If the ID looks like an invoice number (e.g., "INV-00078", "FAC-123")
    if (typeof id === "string" && (id.toUpperCase().startsWith("INV-") || id.toUpperCase().startsWith("FAC-") || (id.includes("-") && id.length > 3))) {
      try {
             const results = await this.getInvoices({ search: id }, 1);
             if (results && results.length > 0) {
               const exact = results.find(o => String(o.number).toUpperCase() === id.toUpperCase()) || results[0];
               if (exact && exact.id) {
                 return await this.getInvoice(exact.id);
               }
             }
      } catch (err) {
        console.warn(`[SellsyClient] Failed to resolve invoice number ${id}:`, err.message);
      }
    }
    const invoice = unwrapItem(await this.request(`/invoices/${id}`));
    return {
      id: invoice.id,
      number: invoice.number,
      subject: invoice.subject,
      status: invoice.status,
      totalAmount: invoice.amounts?.total_incl_tax || invoice.total_incl_tax,
      currency: invoice.currency || invoice.amounts?.currency,
      companyId: invoice.related?.company_id || invoice.company_id,
      contactId: invoice.contact_id,
      createdAt: invoice.created,
      raw: invoice
    };
  }

  // ── Créer une facture ──

  async createInvoice(payload) {
    return unwrapItem(await this.request("/invoices", {
      method: "POST",
      body: payload
    }));
  }

  // ── Marquer une facture comme payée ──

  async markInvoicePaid(id, paidDate = null) {
    return unwrapItem(await this.request(`/invoices/${id}`, {
      method: "PATCH",
      body: { status: "paid", paid_date: paidDate || new Date().toISOString().slice(0, 10) }
    }));
  }

  // ── Envoyer une facture par email ──

  async sendInvoice(id, emailPayload = {}) {
    return await this.request(`/invoices/${id}/send`, {
      method: "POST",
      body: emailPayload
    });
  }

  // ── Recherche de contacts ──

  async searchContacts(query, limit = 10) {
    const data = await this.request("/contacts/search", {
      method: "POST",
      body: {
        filters: { search: query },
        limit,
        order: [{ direction: "desc", field: "updated" }]
      }
    });
    return data.data || [];
  }

  // ── Créer un contact ──

  async createContact(payload) {
    return unwrapItem(await this.request("/contacts", {
      method: "POST",
      body: payload
    }));
  }

  // ── Mettre à jour un contact ──

  async updateContact(id, fields) {
    return unwrapItem(await this.request(`/contacts/${id}`, {
      method: "PATCH",
      body: fields
    }));
  }

  // ── Créer une société ──

  async createCompany(payload) {
    return unwrapItem(await this.request("/companies", {
      method: "POST",
      body: payload
    }));
  }

  // ── Créer une opportunité ──

  async createOpportunity(payload) {
    return unwrapItem(await this.request("/opportunities", {
      method: "POST",
      body: payload
    }));
  }

  // ── Créer un devis ──

  async createQuote(payload) {
    return unwrapItem(await this.request("/estimates", {
      method: "POST",
      body: payload
    }));
  }

  // ── Mettre à jour un devis ──

  async updateQuote(id, fields) {
    return unwrapItem(await this.request(`/estimates/${id}`, {
      method: "PATCH",
      body: fields
    }));
  }

  // ── Envoyer un devis par email ──

  async sendQuote(id, emailPayload = {}) {
    return await this.request(`/estimates/${id}/send`, {
      method: "POST",
      body: emailPayload
    });
  }

  // ── Catalogue produits/services ──

  async getProducts(filters = {}, limit = 25) {
    try {
      const data = await this.request("/items/search", {
        method: "POST",
        body: { filters, limit }
      });
      return data.data || [];
    } catch {
      return [];
    }
  }

  async getProduct(id) {
    return unwrapItem(await this.request(`/items/${id}`));
  }

  // ── Taux de TVA ──

  async getTaxRates() {
    try {
      const data = await this.request("/taxes");
      return data.data || [];
    } catch {
      return [];
    }
  }

  // ── Champs personnalisés ──

  async getCustomFields(entityType) {
    try {
      // entityType: "company", "contact", "opportunity", "invoice", "estimate"
      const data = await this.request(`/custom-fields?entity_type=${entityType}`);
      return data.data || [];
    } catch {
      return [];
    }
  }

  // ── Tags ──

  async getTags() {
    try {
      const data = await this.request("/tags");
      return data.data || [];
    } catch {
      return [];
    }
  }

  async addTagToEntity(entityType, entityId, tagIds) {
    const typeMap = {
      company: "companies",
      contact: "contacts",
      opportunity: "opportunities"
    };
    const endpoint = typeMap[entityType];
    if (!endpoint) throw new Error(`Type d'entité non supporté pour les tags: ${entityType}`);
    return await this.request(`/${endpoint}/${entityId}/tags`, {
      method: "POST",
      body: { tags: tagIds.map(id => ({ id })) }
    });
  }

  // ── Tâches / Tasks ──

  async getTasks(filters = {}, limit = 25) {
    try {
      const data = await this.request("/tasks/search", {
        method: "POST",
        body: { filters, limit }
      });
      return data.data || [];
    } catch {
      return [];
    }
  }

  async createSellsyTask(payload) {
    return unwrapItem(await this.request("/tasks", {
      method: "POST",
      body: payload
    }));
  }

  async updateTask(id, fields) {
    return unwrapItem(await this.request(`/tasks/${id}`, {
      method: "PATCH",
      body: fields
    }));
  }

  // ── Utilisateurs / Équipe ──

  async getTeamUsers() {
    try {
      const data = await this.request("/staffs");
      return data.data || [];
    } catch {
      return [];
    }
  }

  async getCurrentUser() {
    try {
      return unwrapItem(await this.request("/me"));
    } catch {
      return null;
    }
  }

  // ── Statistiques CRM ──

  async getCRMStats() {
    try {
      const [companies, contacts, opps, invoices] = await Promise.allSettled([
        this.request("/companies/search", { method: "POST", body: { limit: 1 } }),
        this.request("/contacts/search", { method: "POST", body: { limit: 1 } }),
        this.request("/opportunities/search", { method: "POST", body: { limit: 1 } }),
        this.request("/invoices/search", { method: "POST", body: { limit: 1 } })
      ]);

      return {
        totalCompanies: companies.status === "fulfilled" ? (companies.value.pagination?.total ?? 0) : null,
        totalContacts: contacts.status === "fulfilled" ? (contacts.value.pagination?.total ?? 0) : null,
        totalOpportunities: opps.status === "fulfilled" ? (opps.value.pagination?.total ?? 0) : null,
        totalInvoices: invoices.status === "fulfilled" ? (invoices.value.pagination?.total ?? 0) : null
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  // ── Recherche globale multi-entités ──

  async globalSearch(query, limit = 5) {
    const [companies, contacts, opps] = await Promise.allSettled([
      this.searchCompanies(query, limit),
      this.searchContacts(query, limit),
      this.getOpportunities({ search: query }, limit)
    ]);

    return {
      companies: companies.status === "fulfilled" ? companies.value : [],
      contacts: contacts.status === "fulfilled" ? contacts.value : [],
      opportunities: opps.status === "fulfilled" ? opps.value : []
    };
  }
}

/**
 * Récupère les données Sellsy pertinentes selon le contexte de la page.
 * @param {SellsyClient} client
 * @param {Object} pageContext - { type, entityId }
 * @returns {Object} - Données enrichies
 */
export async function fetchContextData(client, pageContext) {
  if (!client || !pageContext?.type || pageContext.type === "generic") {
    return { contextType: "generic", data: null };
  }

  try {
    switch (pageContext.type) {
      case "company": {
        const company = await client.getCompany(pageContext.entityId);
        const [activities, mainContact] = await Promise.all([
          client.getActivities("company", pageContext.entityId, 10),
          company.mainContactId
            ? client.getContact(company.mainContactId).catch(() => null)
            : Promise.resolve(null)
        ]);
        return { contextType: "company", data: { company, mainContact, recentActivities: activities } };
      }

      case "contact": {
        const contact = await client.getContact(pageContext.entityId);
        return { contextType: "contact", data: { contact } };
      }

      case "opportunity": {
        const opportunity = await client.getOpportunity(pageContext.entityId);
        let company = null;
        let contact = null;

        // Fetch company and contact in parallel for performance
        const fetches = [];
        if (opportunity.companyId) {
          fetches.push(
            client.getCompany(opportunity.companyId)
              .then((c) => { company = c; })
              .catch(() => { /* pas critique */ })
          );
        }
        if (opportunity.contactId) {
          fetches.push(
            client.getContact(opportunity.contactId)
              .then((c) => { contact = c; })
              .catch(() => { /* pas critique */ })
          );
        }
        await Promise.all(fetches);

        return { contextType: "opportunity", data: { opportunity, company, contact } };
      }

      case "quote": {
        const quote = await client.getQuote(pageContext.entityId);
        let opportunity = null;
        let company = null;
        let contact = null;

        const fetches = [];
        if (quote.opportunityId) {
          fetches.push(
            client.getOpportunity(quote.opportunityId)
              .then((o) => { opportunity = o; })
              .catch(() => { /* pas critique */ })
          );
        }
        if (quote.companyId) {
          fetches.push(
            client.getCompany(quote.companyId)
              .then((c) => { company = c; })
              .catch(() => { /* pas critique */ })
          );
        }
        if (quote.contactId) {
          fetches.push(
            client.getContact(quote.contactId)
              .then((c) => { contact = c; })
              .catch(() => { /* pas critique */ })
          );
        }
        await Promise.all(fetches);

        return { contextType: "quote", data: { quote, opportunity, company, contact } };
      }

      default:
        return { contextType: pageContext.type, data: null };
    }
  } catch (error) {
    return { contextType: pageContext.type, data: null, error: error.message };
  }
}
