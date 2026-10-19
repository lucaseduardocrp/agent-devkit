ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verified_at" TIMESTAMP(3);
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;

-- Existing accounts predate verification and remain usable.
UPDATE "users" SET "email_verified_at" = COALESCE("email_verified_at", "created_at");

CREATE TABLE IF NOT EXISTS "auth_codes" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "auth_codes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "oauth_identities" (
    "id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "oauth_identities_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "oauth_identities" ALTER COLUMN "user_id" TYPE TEXT USING "user_id"::text;
CREATE INDEX IF NOT EXISTS "auth_codes_email_purpose_created_idx" ON "auth_codes"("email", "purpose", "created_at");
CREATE INDEX IF NOT EXISTS "auth_codes_expires_at_idx" ON "auth_codes"("expires_at");
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_identities_provider_user_key" ON "oauth_identities"("provider", "provider_user_id");
CREATE INDEX IF NOT EXISTS "oauth_identities_user_id_idx" ON "oauth_identities"("user_id");
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'oauth_identities_user_id_fkey'
  ) THEN
    ALTER TABLE "oauth_identities" ADD CONSTRAINT "oauth_identities_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
