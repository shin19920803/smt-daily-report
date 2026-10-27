(function (root) {
    const splitRecordsIntoChunks = (records, { maxRows = 500, maxBytes = 512 * 1024 } = {}) => {
        const encoder = new TextEncoder();
        const chunks = [];
        let current = [];
        let currentBytes = 2;
        for (const record of records || []) {
            const recordText = JSON.stringify(record);
            const recordBytes = encoder.encode(recordText).length;
            const separatorBytes = current.length ? 1 : 0;
            if (recordBytes + 2 > maxBytes) throw new Error('單筆 LOG 超過分批上傳容量，請確認原始檔案內容');
            if (current.length && (current.length >= maxRows || currentBytes + recordBytes + separatorBytes > maxBytes)) {
                chunks.push(current);
                current = [];
                currentBytes = 2;
            }
            current.push(record);
            currentBytes += recordBytes + (current.length > 1 ? 1 : 0);
        }
        if (current.length) chunks.push(current);
        return chunks;
    };

    const hashPayload = async payload => {
        const bytes = new TextEncoder().encode(payload);
        if (root.crypto?.subtle) {
            const digest = await root.crypto.subtle.digest('SHA-256', bytes);
            return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
        }
        let hash = 2166136261;
        bytes.forEach(value => { hash ^= value; hash = Math.imul(hash, 16777619); });
        return (hash >>> 0).toString(16).padStart(8, '0');
    };

    const isRetryableUploadError = error => {
        const code = String(error?.code || '');
        if (code === '57014') return false;
        if (/^[0-9A-Z]{5}$/.test(code)) {
            return ['40001', '40P01', '53300', '55P03', '57P01', '57P03'].includes(code);
        }
        const status = Number(error?.status || error?.statusCode || 0);
        if (status) return status === 408 || status === 425 || status === 429 || status >= 500;
        return /network|fetch failed|failed to fetch|connection reset|temporarily unavailable|timeout|逾時|超時/i.test(String(error?.message || error || ''));
    };

    const selectWorkbookSheet = (workbook, { requireDetail = false } = {}) => {
        const sheetNames = Array.isArray(workbook?.SheetNames) ? workbook.SheetNames : [];
        if (requireDetail) {
            if (!sheetNames.includes('Detail') || !workbook?.Sheets?.Detail) {
                throw new Error('找不到 Detail 工作表，請確認上傳檔案包含名稱為 Detail 的分頁；其他工作表不會匯入');
            }
            return workbook.Sheets.Detail;
        }
        const firstSheetName = sheetNames[0];
        const sheet = firstSheetName ? workbook?.Sheets?.[firstSheetName] : null;
        if (!sheet) throw new Error('檔案沒有可讀取的工作表');
        return sheet;
    };

    const readWorkbookRows = (workbook, { requireDetail = false, sheetToJson, isNonEmptyRow } = {}) => {
        if (typeof sheetToJson !== 'function' || typeof isNonEmptyRow !== 'function') {
            throw new TypeError('讀取工作表時缺少必要的轉換函式');
        }
        const sheet = selectWorkbookSheet(workbook, { requireDetail });
        const rows = sheetToJson(sheet, { header: 1, raw: true, defval: '' }).filter(isNonEmptyRow);
        if (requireDetail && !rows.length) {
            throw new Error('Detail 工作表是空白的，沒有可匯入資料；其他工作表不會匯入');
        }
        return rows;
    };

    const api = { splitRecordsIntoChunks, hashPayload, isRetryableUploadError, selectWorkbookSheet, readWorkbookRows };
    root.SMT_DAF_UPLOAD_UTILS = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
