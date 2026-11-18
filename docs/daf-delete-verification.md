# 五站檔案刪除修正（2026-11-18）

## 問題與修正

- 線上 1117.xlsx、1118.xlsx 的有效檔案頭與清單仍存在。原刪除內部按檔名掃候選表的查詢，在唯讀 8 秒限制下逾時。
- 改為使用既有上傳工作 `(file_name,status)` 索引更新工作狀態；不再按檔名掃整張候選表。
- 檔案／製程依一致順序加交易鎖；先取得鎖再建立受影響鍵快照。回選下一筆維持時間、建立時間、id 的排序，改以受影響鍵 lateral 索引查詢。
- 保留原子交易、封存保護、原始候選保留政策與去重邏輯，不新增大型索引。
- RPC 專用 statement_timeout 55 秒、lock_timeout 5 秒與 jit off；不改全站角色逾時。PostgREST 會將支援的函式 timeout 設定提升至交易，schema reload 已通知；非 RPC 的 psql 測試仍需外層設定逾時。
- 新增登入保護的 `daf_log_file_exists(text)`，查核有效檔案頭與摘要；沒有開放瀏覽器直接讀內部表的權限。
- 前端不自動重送刪除：若回應遺失，先確認資料是否確實不存在。任一來源仍存在或查核失敗，不回報成功。
- 刪除中顯示狀態、防連點及同頁上傳競爭；失敗顯示原因。成功後使五站衍生資料失效，清單只讀 Supabase，不以 Cloudflare 舊備援覆蓋已確認刪除。

## 驗證

`node --test tests/*.test.mjs tests/*.test.js`：129 項通過。

隔離 PostgreSQL 測試涵蓋：22,000 筆刪除結果與舊版完整摘要雜湊相同、migration 重跑不變更資料、重複刪除、下一筆最早候選回選、E 空白資料移除、封存阻擋及完整回滾、存在性查核與未登入拒絕。

前端測試涵蓋：回應遺失但已刪除、有效頭／摘要殘留、查核失敗、權威刷新失敗、防連點與上傳中阻擋。

線上替代工作查詢 EXPLAIN ANALYZE 約 30.792 ms；這是單一查詢，不是完整刪除耗時。1117／1118 摘要修正前後 MD5 均為 `5e3359369d09743a3817acdf5685f8fd`。本次沒有代使用者刪除這兩檔，也沒有在正式環境做破壞性測試；實際點擊刪除與跨電腦端到端結果仍待確認。

## 回復

舊刪除函式備份：`/Users/shin1992/Claude/smt-daily-report-backups/delete-fix-20261118.9t1dmw/restore-delete-function.sql`。

若需回復，先停止使用新版前端的刪除功能，再使用專案安全憑證 helper 以 `psql -v ON_ERROR_STOP=1 -f` 套回該函式並 `NOTIFY pgrst, 'reload schema'`。新存在性查核函式可保留（唯讀）；不要為回復刪除生產資料。舊版可能再次遇到逾時，不應當成長期解法。

參考：[Supabase RPC timeout](https://supabase.com/docs/guides/database/postgres/timeouts)、[PostgREST transaction hoisted settings](https://docs.postgrest.org/en/v13/references/transactions.html)。
