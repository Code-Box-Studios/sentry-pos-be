-- Historical batches with unknown branch stay unassigned; never guess a tenant
-- branch from a product that can be stocked in several locations.
CREATE INDEX stock_batches_branch_product_idx ON stock_batches(branch_id, product_id, variant_id, expires_at);
CREATE INDEX stock_movements_transfer_idx ON stock_movements(transfer_id) WHERE transfer_id IS NOT NULL;
CREATE INDEX stock_counts_branch_created_idx ON stock_counts(branch_id, created_at);
ALTER TABLE stock_count_items ADD CONSTRAINT stock_count_items_counted_nonnegative CHECK (counted_qty >= 0);
ALTER TABLE stock_count_items ADD CONSTRAINT stock_count_items_expected_nonnegative CHECK (expected_qty >= 0);
