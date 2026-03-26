-- CreateTable
CREATE TABLE "impersonation_sessions" (
    "id" TEXT NOT NULL,
    "admin_id" INTEGER NOT NULL,
    "target_id" INTEGER NOT NULL,
    "token_jti" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "impersonation_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_types" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "logo_url" TEXT,
    "config_schema" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_integrations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "integration_type_id" TEXT NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "encrypted_config" TEXT NOT NULL,
    "configured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "configured_by_user_id" INTEGER,

    CONSTRAINT "workspace_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_integrations" (
    "id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "integration_type_id" TEXT NOT NULL,
    "encrypted_credentials" TEXT NOT NULL,
    "linked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "impersonation_sessions_token_jti_key" ON "impersonation_sessions"("token_jti");

-- CreateIndex
CREATE INDEX "impersonation_sessions_admin_id_idx" ON "impersonation_sessions"("admin_id");

-- CreateIndex
CREATE INDEX "impersonation_sessions_target_id_idx" ON "impersonation_sessions"("target_id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_types_name_category_key" ON "integration_types"("name", "category");

-- CreateIndex
CREATE INDEX "workspace_integrations_workspace_id_idx" ON "workspace_integrations"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_integrations_workspace_id_integration_type_id_key" ON "workspace_integrations"("workspace_id", "integration_type_id");

-- CreateIndex
CREATE INDEX "user_integrations_user_id_idx" ON "user_integrations"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_integrations_user_id_integration_type_id_key" ON "user_integrations"("user_id", "integration_type_id");

-- AddForeignKey
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_integrations" ADD CONSTRAINT "workspace_integrations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_integrations" ADD CONSTRAINT "workspace_integrations_integration_type_id_fkey" FOREIGN KEY ("integration_type_id") REFERENCES "integration_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_integrations" ADD CONSTRAINT "workspace_integrations_configured_by_user_id_fkey" FOREIGN KEY ("configured_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_integrations" ADD CONSTRAINT "user_integrations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_integrations" ADD CONSTRAINT "user_integrations_integration_type_id_fkey" FOREIGN KEY ("integration_type_id") REFERENCES "integration_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;
