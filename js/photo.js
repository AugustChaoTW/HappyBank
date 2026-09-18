// 手機照片 → canvas 壓縮 → 純 base64（SPEC §7.5）。
// 壓縮不是最佳化而是可行性：原圖 3～5MB 直送 Apps Script 會逾時，
// 小孩看到轉圈就再按一次，Drive 裡就多一張照片。
// 所以這裡**壓不出來就丟例外**，呼叫端請小孩重拍，絕對不 fallback 送原圖。
const Photo = (() => {
  const MAX_EDGE = 1280;      // 最長邊；比這小的不放大
  const QUALITY = 0.8;
  const PREFIX = 'data:image/jpeg;base64,';

  // iPhone 直拍的照片畫進 canvas 常常躺平，EXIF 方向交給瀏覽器處理。
  // 不支援 options 的瀏覽器就接受躺平（家長看得懂就好），不自寫 EXIF parser。
  async function toBitmap(file) {
    if (typeof createImageBitmap === 'function') {
      try {
        return await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch (err) {
        // 舊 Safari 不吃第二個參數，整組 reject；退回 <img>
        console.warn('createImageBitmap 失敗，改用 <img>', err);
      }
    }
    return await fromImageElement(file);
  }

  function fromImageElement(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      // HEIC 這類瀏覽器解不開的格式會走到這裡
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode-failed')); };
      img.src = url;
    });
  }

  // base64 還原成位元組數，用來跟伺服器的 1.5MB 上限對照（SPEC §7.2-4）
  function bytesOf(base64) {
    const pad = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    return Math.floor(base64.length * 3 / 4) - pad;
  }

  // 回傳 { base64, mime, dataUrl, bytes, width, height }；任何一步失敗一律 throw
  async function compress(file) {
    if (!file) throw new Error('no-file');

    const src = await toBitmap(file);
    const sw = src.width || src.naturalWidth;
    const sh = src.height || src.naturalHeight;
    if (!sw || !sh) throw new Error('empty-image');

    const scale = Math.min(1, MAX_EDGE / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no-canvas-context');
    ctx.drawImage(src, 0, 0, w, h);
    if (typeof src.close === 'function') src.close();

    // toDataURL 失敗時有些瀏覽器回 'data:,'，不是丟例外——自己檢查前綴
    const dataUrl = canvas.toDataURL('image/jpeg', QUALITY);
    if (typeof dataUrl !== 'string' || dataUrl.indexOf(PREFIX) !== 0) {
      throw new Error('encode-failed');
    }
    const base64 = dataUrl.slice(PREFIX.length);
    if (base64.length < 64) throw new Error('encode-empty');

    return { base64, mime: 'image/jpeg', dataUrl, bytes: bytesOf(base64), width: w, height: h };
  }

  return { compress, bytesOf, MAX_EDGE, QUALITY };
})();
