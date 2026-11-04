# 發布受影響鍵查詢修正（2026-11-04）

- 問題：`daf_finalize_log_import` 的 DISTINCT ON 選勝出資料計畫，先將 362,002 筆活躍候選雜湊，再匹配約 25,182 個受影響鍵，並產生磁碟排序。正式環境唯讀 EXPLAIN 的此步驟約 19.1 秒。
- 修正：對每個受影響 `(line,dedup_key)` 使用 LATERAL + LIMIT 1 索引查詢。最早時間、created_at、id 順序、封存排除、製程鎖、失敗回滾、原子發布及摘要計算不變。
- 線上只讀差異驗證：新舊各選出 25,015 筆勝出 ID，雙向 EXCEPT 無差異。相同連線中舊步驟約 15.311 秒、新步驟約 3.995 秒；這不是完整上傳耗時保證。
- 本機：44 批、22,000 筆原子發布成功；遷移重跑、完整既有摘要雜湊一致測試通過。
- JavaScript：48 項測試通過。
- 線上遷移前後 daf_log_batches 全表摘要雜湊相同。遷移僅替換函式，未重傳／刪除生產檔案。
- 尚未取得原始 1103.xlsx，因此未以此原檔實測完整上傳；不可宣稱所有網路、鎖定或 IO 逾時已永遠消除。

## 可重跑驗證

本機隔離測試：`node tests/daf-finalize-plan.test.mjs`

線上唯讀選擇等價測試（僅建立暫存表、最後 ROLLBACK）：
`bash scripts/with-supabase-db.sh psql -X -f tests/daf-finalize-key-equivalence.sql`

上線：`bash scripts/with-supabase-db.sh psql -X -v ON_ERROR_STOP=1 -f supabase/daf_finalize_key_lookup_fix.sql`

須在既有發布／精簡／plan 遷移後執行。遷移含結構檢查，未知函式內容會中止，不可移除檢查硬套。

本次套用前函式已保存於本機 `/tmp/daf-finalize-rollback-20261104.sql`；此為暫存回復檔，非完整資料庫備份。若需回復，只能在確認未有後續函式變更後，以 psql ON_ERROR_STOP 執行該檔。既有正式備份 ZIP 未更動。
