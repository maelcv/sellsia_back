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
    this._accessToken = credentials.type === "token" ? credentials.token : null;
    this._tokenExpiry = 0;
  }

  /**
   * Obtient un access token (cache pour OAuth, direct pour token).
   */
  async getAccessToken() {
    if (this.credentials.type === "token") {
      return this.credentials.token;
    }

    // OAuth: refresh si expiré
    if (this._accessToken && Date.now() < this._tokenExpiry) {
      return this._accessToken;
    }

    const response = await fetch("https://login.sellsy.com/oauth2/access-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret
      })
    });

    if (!response.ok) {
      throw new Error(`Sellsy OAuth failed: ${response.status}`);
    }

    const data = await response.json();
    this._accessToken = data.access_token;
    this._tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
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
      throw new Error(`Sellsy API ${response.status}: ${err.message || err.error || "Unknown"}`);
    }

    return response.json();
  }

  // ── Sociétés / Companies ──

  async getCompany(id) {
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
    const opp = unwrapItem(await this.request(`/opportunities/${id}`));
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
        body: { filters, limit }
      });
      return data.data || [];
    } catch {
      return [];
    }
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
