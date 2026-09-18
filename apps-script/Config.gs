// HappyBank — 專案共用設定
// Apps Script 把同一個專案的所有 .gs 併成同一個全域範圍，
// 所以 SHEET_ID / TOKEN 只能在這裡宣告一次，Code.gs 與 Setup.gs 共用。

// Google Sheet「HappyBank 資料庫」
const SHEET_ID = '1Po7HzNFbi90EvLuKpor69CuMAoU_nYjbUMh-RsBEOvo';

// 與 js/config.js 的 apiToken 一致。
// 這組密鑰跟前端一起公開在 GitHub 上，只是雜訊過濾，不是安全機制——
// 真正的身分驗證是登入拿到的 session（SPEC §8）。
const TOKEN = 'hb-10c4cc80462d2b4c';
