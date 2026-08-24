-- stock can never go negative (project-spec §6)
ALTER TABLE branch_stock ADD CONSTRAINT branch_stock_qty_nonnegative CHECK (qty >= 0);

-- one stock row per (branch, product[, variant]) — NULL variant_id needs partial uniques
CREATE UNIQUE INDEX branch_stock_product_uq ON branch_stock (branch_id, product_id) WHERE variant_id IS NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX branch_stock_variant_uq ON branch_stock (branch_id, product_id, variant_id) WHERE variant_id IS NOT NULL AND deleted_at IS NULL;

-- SKU/barcode unique per business among LIVE products only (soft-deleted rows release theirs)
CREATE UNIQUE INDEX products_business_sku_uq ON products (business_id, sku) WHERE deleted_at IS NULL AND sku IS NOT NULL;
CREATE UNIQUE INDEX products_business_barcode_uq ON products (business_id, barcode) WHERE deleted_at IS NULL AND barcode IS NOT NULL;

-- audit_logs is immutable to EVERYONE (project-spec §11) — belt and suspenders under the app-layer block
CREATE OR REPLACE FUNCTION forbid_audit_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_logs is append-only'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();
