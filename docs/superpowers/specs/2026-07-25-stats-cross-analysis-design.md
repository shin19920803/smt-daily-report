# 統計交叉分析強化 + 檔案模組化拆分

日期：2026-07-25

## 目標
1. 將單一 index.html（2435 行）拆為功能模組，之後修改單一功能只需讀取小檔案（省 token）。
2. 統計頁加入完整交叉分析：現象×位置×機種×工單 全維度互查，含數量與比例。
3. 原有 Excel 導出格式不變（良率報告 / 每日明細 / 直通率報告 三分頁保留），僅新增「交叉分析」分頁。

## 檔案結構
```
index.html            純 HTML 模板 + CDN + script 引用
css/main.css          原內嵌樣式
js/supabase-client.js Supabase 初始化 + Vue API 解構（全域共享）
js/core.js            共用狀態：tab/loading/data/toast/FPY目標/工單清單/loadBaseData
js/orders.js          工單管理 + 生產日曆 + 機種群組
js/report.js          每日報工 + 不良紀錄 + CSV 匯入 + Raw Data 導出
js/fpy.js             直通率管理
js/ooc.js             OOC 紀錄
js/dashboard.js       儀表板 + ECharts
js/stats.js           統計與導出（本次強化重點）
js/equipment.js       設備管理（Feeder/Nozzle）
js/settings.js        基礎設定
js/app.js             入口：組裝 ctx、onMounted、break-list 共用元件
```
模組模式：`SMT.<module> = function (ctx) { ...; return {exports}; }`，app.js 依序呼叫並
`Object.assign(ctx, ...)`，setup() 回傳 ctx。跨模組依賴由 ctx 解構（載入順序保證存在）。
無 build 工具，純 `<script>` 共享全域 lexical scope。

## 統計強化
- calculateStats 一次建立：typeLocMap / typeModelMap / typeWoMap / locWoMap / locModelMap /
  locTypeMap / modelAgg / woAgg / byModel / byWo / fpyTrend。
- 下鑽（皆含數量+比例+排名橫條，用 break-list 元件）：
  - 現象 → 位置×機種×工單
  - 位置（Modal）→ 工單×機種×現象
  - 機種分析表（投入/不良/不良率/佔比）→ 現象×位置×工單
  - 工單分析表（機種/投入/不良/不良率/佔比）→ 現象×位置
  - 各下鑽面板可互相跳轉（點位置開位置 Modal、點機種開機種下鑽…）
- 新圖表：現象×位置 熱力圖（Top8×Top12）、SPI/AOI 直通率趨勢（每日平均+目標線）。
- Excel「交叉分析」新分頁：機種彙總 / 工單彙總 / 現象×機種 / 現象×位置 / 現象×工單 /
  位置×機種 / 位置×工單。原三分頁程式碼原樣保留。

## 驗證
- 本機 http.server + 瀏覽器實測：8 個分頁全部切換無 console 錯誤。
- 統計執行（2026-06-01~07-25，總投入 389452 / 不良 298）：Pareto、熱力圖、FPY 趨勢、
  現象/機種/工單下鑽數據與比例皆正確渲染。
- 刪除未被引用的舊死檔 app.js / styles.css（root）。
