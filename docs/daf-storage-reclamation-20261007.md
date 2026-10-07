# 五站實體空間回收修正

## 根因

2026-10-07 的線上封存已移除舊候選並保留歷史報表輸入，但只執行普通 VACUUM。
候選／勝出表內的空頁與索引配置仍占容量，加上 compact facts 新增配置，使整庫由
632,728,723 增至 713,960,595 bytes。這不是 Dashboard 多計數，而是缺少實體回收。

## 修正

- `reclaim-daf-storage.sh` 先驗證磁碟餘裕，安裝五站寫入維護保護，建立並驗證最新完整備份。
- 依序對 winners、candidates、compact facts 執行 PostgreSQL 原子重寫 `VACUUM FULL`。
- 全日期報表指紋、四張資料表逐列雜湊及筆數須完全一致，且整庫實測變小才能回報成功。
- 任何退出皆嘗試恢復寫入；若網路中斷，會提供解除維護的 SQL。
- 維持 14 天候選、30 天未匹配機台參照；候選／勝出表加快 autovacuum，讓後續刪除的空頁可重用。
- 原封存脚本依前後實際容量回報結果，不再把普通 VACUUM 當成實體縮容完成。

此流程不清空資料表。重寫中的讀取會等待表鎖，原有前端錯誤分支保留已確認畫面，
Cloudflare 的 `withCache` 不會快取非成功回應。SMT／Mylar 未改動。

## 本機實測

來源：20261007-205310 的最新完整備份，還原 public schema 至隔離的 PostgreSQL 17 資料庫。

- 精簡後、回收前：567,793,331 bytes。
- 三表回收後：365,098,675 bytes，減少 202,694,656 bytes。
- 全歷史報表、每日報工摘要及三張明細表逐列指紋相同。
- 候選 182,530、勝出 158,701、歷史 facts 661,533。
- 界線 2026-09-23，保留政策 14 天。
- 重跑核對及維護保護測試通過：拒絕新上傳、寫入／TRUNCATE、第二個維護者、接收中工作；維護時歷史讀取仍非空。
- JavaScript 上傳分批工具測試 5/5 通過。

本機只還原 public schema，以上容量不可直接當作線上最終整庫容量。
正式網站磁碟控制台已確認 8 GB 配置、约 0.97 GB 使用，可保守以 6,000,000,000 bytes 餘裕啟動。
目前尚待安全輸入資料庫密碼，未執行這次線上實體回收。

## 執行及復原

```sh
cd /Users/shin1992/Claude/smt-daily-report
KOYA_DISK_FREE_BYTES=6000000000 bash scripts/reclaim-daf-storage.sh aws-1-ap-south-1.pooler.supabase.com postgres.ccwkcwriebxipndxkvyr
```

只在出現密碼提示後輸入，密碼不寫入 Git 或日誌。
若連線中断導致維護狀態留存，先確認回收程序已結束，使用同一資料庫的 SQL Editor 執行：

```sql
select public.daf_end_space_reclamation();
```

VACUUM FULL 失敗會保留原表；如需災難復原，使用腳本產生的 `smt-pre-reclaim-*.dump`，
先在隔離資料庫驗證還原，不用舊快照覆盖新的線上上傳。

## 可重跑驗證

```sh
/opt/homebrew/opt/postgresql@17/bin/psql -X -h /tmp -p 55439 -U postgres -d koya_reclaim_20261007 -f tests/daf-space-reclamation.test.sql
node --test tests/daf-upload-utils.test.js
bash -n scripts/reclaim-daf-storage.sh
git diff --check
```
