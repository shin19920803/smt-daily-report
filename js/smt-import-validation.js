window.SMT = window.SMT || {};

SMT.validateSmtReportFilename = (fileName, workOrder) => {
    const expected = String(workOrder ?? '').trim();
    if (!expected) throw new Error('目前報工工單資料不完整，請重新選擇工單後再上傳');
    // The optional date is a filename prefix, not a restriction on report dates.
    const match = /^(?:\d{8}_)?(.+)\.csv$/i.exec(String(fileName ?? '').trim());
    if (!match) throw new Error(`檔名格式錯誤，請使用「YYYYMMDD_${expected}.csv」或「${expected}.csv」`);
    const actual = match[1].trim();
    if (actual.toUpperCase() !== expected.toUpperCase()) {
        throw new Error(`檔名工單「${actual}」與目前報工工單「${expected}」不同，已阻擋匯入`);
    }
};

// Check the same first-sheet/header layout consumed by the existing importers.
// Format recognition must finish before creating settings or writing records.
SMT.validateSmtImport = (rows, target) => {
    const normalize = value => String(value ?? '').normalize('NFKC').replace(/[\s\uFEFF]/g, '').toUpperCase();
    const headers = Array.isArray(rows?.[0]) ? rows[0].map(normalize) : [];
    const defectLabels = new Set(['瑕疵項目', '瑕疵项目']);
    const hasDefectHeader = headers.some(value => defectLabels.has(value));
    const find = key => headers.findIndex(value => value.includes(key));
    const columns = { iDate: find('日期'), iWo: find('工單'), iModel: find('機種'), iSpi: find('SPI'), iAoi: find('AOI') };
    const hasFpyHeader = columns.iDate >= 0 && columns.iSpi >= 0 && columns.iAoi >= 0;
    if (hasDefectHeader && hasFpyHeader) {
        throw new Error('同時包含瑕疵項目與直通率欄位，無法確認檔案類型；請分開上傳兩種表格');
    }
    if (target === 'defects') {
        if (hasFpyHeader) throw new Error('這是直通率檔案，請前往「直通率管理」上傳；工單檔案上傳只接受「瑕疵項目」表格');
        if (!defectLabels.has(headers[0]) || !headers.slice(1).some(Boolean)) {
            throw new Error('報工檔案格式錯誤：第一欄標題須為「瑕疵項目」，右側須有位置代碼');
        }
        if (!rows.slice(1).some(row => String(row?.[0] ?? '').trim())) {
            throw new Error('報工檔案沒有瑕疵項目資料');
        }
    } else if (target === 'fpy') {
        if (hasDefectHeader) throw new Error('這是瑕疵項目檔案，請前往「工單管理 → 檔案上傳」上傳；此處只接受直通率表格');
        if (!hasFpyHeader || columns.iWo < 0 || new Set([columns.iDate, columns.iWo, columns.iSpi, columns.iAoi]).size !== 4) {
            throw new Error('直通率檔案格式錯誤：須有「日期」、「工單」、「SPI」及「AOI」四個獨立欄位；SPI 或 AOI 的數值可留白');
        }
        if (rows.length < 2) throw new Error('直通率檔案沒有資料');
    } else {
        throw new Error('未知的 SMT 匯入類型');
    }
    return { columns };
};
