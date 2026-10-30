def remove_work_item_schema(db):
    """Strip v12 additions before a fixture simulates an older database."""
    db.execute('DROP TABLE work_item_verifications')
    db.execute('DROP INDEX runs_work_item')
    db.execute('ALTER TABLE runs DROP COLUMN work_item_id')
    db.execute('DROP TABLE work_items')
