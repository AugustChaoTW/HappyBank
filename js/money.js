// 金額與日期的共用算式。全部是整數元，不處理小數（SPEC §3）。
const Money = (() => {

  function format(n) {
    const v = Math.round(Number(n) || 0);
    return v.toLocaleString('zh-TW', { maximumFractionDigits: 0 });
  }

  // 與伺服器端同一條式子，不足 1 元就是 0 元
  function monthlyInterest(balance, rateMonthly) {
    return Math.round((Number(balance) || 0) * (Number(rateMonthly) || 0));
  }

  // 粗估而已：假設之後每週都存一樣多，不把利息算進去。
  // 存錢速度不明（或已達標）時回 null，讓畫面自己決定要不要講。
  function weeksToTarget(current, target, weeklyRate) {
    const gap = (Number(target) || 0) - (Number(current) || 0);
    if (gap <= 0) return null;
    const rate = Number(weeklyRate) || 0;
    if (rate <= 0) return null;
    return Math.ceil(gap / rate);
  }

  function parse(isoDate) {
    if (!isoDate) return null;
    const d = new Date(isoDate);
    return isNaN(d.getTime()) ? null : d;
  }

  // 以「天」為單位比較，同一天回 0，過期回負數
  function daysUntil(isoDate) {
    const d = parse(isoDate);
    if (!d) return null;
    const day = 24 * 60 * 60 * 1000;
    const a = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const now = new Date();
    const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return Math.round((a - b) / day);
  }

  function formatDate(isoDate) {
    const d = parse(isoDate);
    if (!d) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  }

  // 「更新於 ○○」用：今天只講時間，昨天以前補上日期
  function formatWhen(isoTs) {
    const d = parse(isoTs);
    if (!d) return '';
    const pad = n => String(n).padStart(2, '0');
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return daysUntil(isoTs) === 0 ? `今天 ${hm}` : `${formatDate(isoTs)} ${hm}`;
  }

  return { format, monthlyInterest, weeksToTarget, daysUntil, formatDate, formatWhen };
})();
