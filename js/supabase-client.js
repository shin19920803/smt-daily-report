const { createApp, ref, computed, onMounted, watch, reactive } = Vue;
const { createClient } = supabase;

const SUPABASE_URL = 'https://ccwkcwriebxipndxkvyr.supabase.co'; 
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNjd2tjd3JpZWJ4aXBuZHhrdnlyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkzODk4MTgsImV4cCI6MjA4NDk2NTgxOH0.fUHOdc7OZVTwv6XjkmYU7uSkJMIy83OTvM7rD1n81Ic';
const _supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
// 只將 DAF／組裝測試的摘要讀取交給 Cloudflare；Worker 異常時由 daf.js 自動回退 Supabase。
window.KOYA_DATA_CACHE_URL = 'https://koya-data-cache.shin19920803.workers.dev';
