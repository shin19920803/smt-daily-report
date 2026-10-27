# 五大製程 FP 代號正規化（2026-10-27）

## 範圍

- 上傳產品代號、未知機種對話框、機種記憶與後續比對只使用獨立的 `FP-` 英數代號（容許代號內連字號）。同一儲存格有多個不同 FP 代號時拒絕任意選一個。
- 保留原例外：`RFPCB,DAF,TAROKO 14''`、`RFPCB,DAF,TAROKO 14,SYNAPTICS`、`MS3633-T07`。
- 使用者確認：`FP-D01321BE11` → B24-ELAN，`FP-D01524BK11` → B27-ELAN。
- 只遷移 `daf_log_batches` 的機種記憶列；不重寫候選、勝出、精簡歷史、數量、RAW、E/F 去重欄位或機台參照。既有資料在前端載入時會使用精簡代號進行比對。
- 不修改 SMT、Mylar、登入、保留期限或快取排程。

## 資料庫保護

`supabase/daf_model_code_normalization.sql` 在單一交易中：

1. 設定 2 秒鎖定逾時／15 秒執行逾時，短暫鎖定來源表的寫入，不阻擋一般讀取。
2. 預檢所有機種記憶可被正規化，且除指定兩組外無未確認衝突；否則回滾。
3. 依代號合併記憶並保存最新來源時間，保留三項例外；不因重跑而更改時間。
4. 以 ID／完整列雜湊核對所有非機種記憶列未變動，失敗則整筆回滾。
5. 新增僅作用於機種記憶的 BEFORE trigger，攔截舊分頁的雜訊寫入並統一 ID／product_code／records；普通生產列不經過正規化 trigger。

## 驗證

```sh
node --test tests/*.test.mjs tests/*.test.js
node scripts/test-daf-aggregate-weighting.mjs
node --check js/daf.js
node --check js/daf-upload-utils.js
git diff --check
```

- 74 項 Node 測試通過。
- 隔離 PostgreSQL 17：`tests/daf-model-code-migration.test.sql` 驗證重跑、例外、核准衝突、舊網頁寫入及非機種記憶資料不變。此測試只允許在名為 `daf_model_code_test` 的拋棄式本機資料庫執行，禁止在 Production 執行。
- 最新線上機種記憶快照 51 列，在隔離資料庫試跑合併為 24 列，雜訊列 0。
- 線上遷移完成：51 → 24 列，雜訊列 0；同一交易核對其餘 8,664 列完全一致。兩項 TAROKO 記憶留存，MS3633-T07 仍為內建規則。
- 尚未使用使用者正式 Excel 執行線上上傳，避免建立測試生產資料。

## 備份與回復

機種記憶原始 JSON 列的 CSV 備份（不含帳密與生產 RAW）：

`/Users/shin1992/Claude/smt-daily-report-backups/daf-model-memory-20261027-171610.csv`

若需回復，先在隔離資料庫演練：用單一交易及同樣表鎖，停用本次新增的 `daf_model_code_memory_guard`，將 CSV 匯入單欄 JSONB 臨時表，僅刪除機種記憶列，再以 `jsonb_populate_record(null::public.daf_log_batches,payload)` 回填原始列，核對非機種記憶列後提交。回復前須先確認上線後沒有新增機種記憶；若已有新增，不可用舊快照直接覆蓋。生產表、RAW、帳號及其他 trigger 均不在回復範圍。
