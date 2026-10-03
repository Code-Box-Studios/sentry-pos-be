ALTER TYPE "UserRole" ADD VALUE 'manager';
ALTER TYPE "UserRole" ADD VALUE 'cashier';
ALTER TYPE "ActorType" ADD VALUE 'staff';

CREATE TYPE "StaffStatus" AS ENUM ('pending', 'active', 'deactivated');
CREATE TYPE "StaffChallengeKind" AS ENUM ('manager_setup', 'cashier_setup', 'pin_reset', 'password_reset');

ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "businesses" ADD COLUMN "blind_close_enabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "staff_profiles" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "user_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "StaffStatus" NOT NULL DEFAULT 'pending',
    CONSTRAINT "staff_profiles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "staff_branches" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "staff_profile_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    CONSTRAINT "staff_branches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "staff_challenges" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "StaffChallengeKind" NOT NULL,
    "pin_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "staff_challenges_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "operator_sessions" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "terminal_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "last_activity_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    CONSTRAINT "operator_sessions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "shifts"
    ADD COLUMN "operator_user_id" UUID,
    ADD COLUMN "closed_by_user_id" UUID,
    ADD COLUMN "emergency_close_reason" TEXT;
ALTER TABLE "shift_cash_movements" ADD COLUMN "operator_user_id" UUID;
ALTER TABLE "sales"
    ADD COLUMN "operator_user_id" UUID,
    ADD COLUMN "status_requested_by_user_id" UUID,
    ADD COLUMN "status_approved_by_user_id" UUID;
ALTER TABLE "stock_movements"
    ADD COLUMN "operator_user_id" UUID,
    ADD COLUMN "approved_by_user_id" UUID;

CREATE UNIQUE INDEX "staff_profiles_user_id_key" ON "staff_profiles"("user_id");
CREATE INDEX "staff_profiles_business_id_status_idx" ON "staff_profiles"("business_id", "status");
CREATE UNIQUE INDEX "staff_branches_staff_profile_id_branch_id_key" ON "staff_branches"("staff_profile_id", "branch_id");
CREATE INDEX "staff_branches_branch_id_idx" ON "staff_branches"("branch_id");
CREATE INDEX "staff_challenges_user_id_kind_expires_at_idx" ON "staff_challenges"("user_id", "kind", "expires_at");
CREATE UNIQUE INDEX "operator_sessions_token_hash_key" ON "operator_sessions"("token_hash");
CREATE INDEX "operator_sessions_terminal_id_revoked_at_idx" ON "operator_sessions"("terminal_id", "revoked_at");
CREATE INDEX "operator_sessions_user_id_revoked_at_idx" ON "operator_sessions"("user_id", "revoked_at");

ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "staff_branches" ADD CONSTRAINT "staff_branches_staff_profile_id_fkey" FOREIGN KEY ("staff_profile_id") REFERENCES "staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "staff_branches" ADD CONSTRAINT "staff_branches_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "staff_challenges" ADD CONSTRAINT "staff_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "operator_sessions" ADD CONSTRAINT "operator_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "operator_sessions" ADD CONSTRAINT "operator_sessions_terminal_id_fkey" FOREIGN KEY ("terminal_id") REFERENCES "terminals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "operator_sessions" ADD CONSTRAINT "operator_sessions_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_operator_user_id_fkey" FOREIGN KEY ("operator_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_closed_by_user_id_fkey" FOREIGN KEY ("closed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "shift_cash_movements" ADD CONSTRAINT "shift_cash_movements_operator_user_id_fkey" FOREIGN KEY ("operator_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "sales" ADD CONSTRAINT "sales_operator_user_id_fkey" FOREIGN KEY ("operator_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "sales" ADD CONSTRAINT "sales_status_requested_by_user_id_fkey" FOREIGN KEY ("status_requested_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "sales" ADD CONSTRAINT "sales_status_approved_by_user_id_fkey" FOREIGN KEY ("status_approved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_operator_user_id_fkey" FOREIGN KEY ("operator_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
