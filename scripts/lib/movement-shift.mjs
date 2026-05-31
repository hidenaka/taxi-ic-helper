// movement-shift — b3 方式の核心: 列の1次元輝度プロファイル間の前進シフト量を
// 正規化クロス相関(Pearson)で推定する純関数群。画像I/Oには依存しない。

// Jimp 画像から輝度サンプラ getLum(px,py) を作る。lum=0.299R+0.587G+0.114B(既存規約)。
export function jimpLumSampler(img) {
  const { data, width } = img.bitmap;
  return (x, y) => {
    const idx = (y * width + x) * 4;
    return 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
  };
}

/**
 * Jimp 画像と順序付きスロット定義から、レーン軸に沿った1次元輝度プロファイルを作る。
 * @param {*} img Jimp 画像
 * @param {{cx:number,cy:number}[]} slots 先頭→末尾順のスロット中心(正規化座標)
 * @param {{oversample?:number, radius?:number}} opts
 * @returns {number[]}
 */
export function profileForSlots(img, slots, opts = {}) {
  const oversample = opts.oversample ?? 3;
  const radius = opts.radius ?? 1;
  const pts = laneSamplePoints(slots, oversample);
  const getLum = jimpLumSampler(img);
  return sampleProfile(pts, getLum, img.bitmap.width, img.bitmap.height, radius);
}

function mean(arr) {
  let s = 0;
  for (const v of arr) s += v;
  return arr.length ? s / arr.length : 0;
}

// b[i] を a[i-d] に対応させたときの、重なり区間での Pearson 相関。
// 平坦(分散0)なプロファイルは 0 を返す(=動きの根拠なし)。
function correlationAtLag(a, b, d) {
  const xs = [];
  const ys = [];
  for (let i = 0; i < b.length; i++) {
    const j = i - d;
    if (j < 0 || j >= a.length) continue;
    xs.push(a[j]);
    ys.push(b[i]);
  }
  if (xs.length < 2) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let k = 0; k < xs.length; k++) {
    const ax = xs[k] - mx;
    const ay = ys[k] - my;
    num += ax * ay;
    dx += ax * ax;
    dy += ay * ay;
  }
  if (dx === 0 || dy === 0) return 0;
  return num / Math.sqrt(dx * dy);
}

/**
 * 2つの1次元プロファイル a, b の最良シフト量を返す。
 * lag = d は「b が a を右に d ずらした波形」のとき d。前進方向の符号は呼び出し側で解釈する。
 * @returns {{lag:number, score:number}} score は正規化相関のピーク値(-1..1)。
 */
export function bestShift(a, b, maxLag = 3) {
  let best = { lag: 0, score: -Infinity };
  for (let d = -maxLag; d <= maxLag; d++) {
    const s = correlationAtLag(a, b, d);
    if (s > best.score || (s === best.score && Math.abs(d) < Math.abs(best.lag))) {
      best = { lag: d, score: s };
    }
  }
  return best;
}

/**
 * 順序付きスロット中心列(正規化座標)から、列(レーン)軸に沿ったサンプル点列を作る。
 * oversample=1 でスロット中心そのまま、k>1 で各区間を k 分割して補間し細かく標本化する。
 * @param {{cx:number,cy:number}[]} slots 先頭→末尾の順
 * @param {number} oversample 1区間あたりの分割数
 * @returns {{cx:number,cy:number}[]}
 */
export function laneSamplePoints(slots, oversample = 1) {
  if (!Array.isArray(slots) || slots.length === 0) return [];
  if (oversample <= 1 || slots.length === 1) {
    return slots.map((s) => ({ cx: s.cx, cy: s.cy }));
  }
  const pts = [];
  for (let i = 0; i < slots.length - 1; i++) {
    const a = slots[i];
    const b = slots[i + 1];
    for (let j = 0; j < oversample; j++) {
      const t = j / oversample;
      pts.push({ cx: a.cx + (b.cx - a.cx) * t, cy: a.cy + (b.cy - a.cy) * t });
    }
  }
  const last = slots[slots.length - 1];
  pts.push({ cx: last.cx, cy: last.cy });
  return pts;
}

/**
 * サンプル点列(正規化座標)の輝度を取り、1次元プロファイルにする。
 * getLum(px,py) は画素輝度を返す注入関数(画像I/Oから独立させてテスト可能にする)。
 * radius>0 のとき (2r+1)^2 近傍の平均を取り、画像端でクランプする。
 * @returns {number[]}
 */
export function sampleProfile(points, getLum, imgW, imgH, radius = 0) {
  return points.map(({ cx, cy }) => {
    const px = Math.round(cx * (imgW - 1));
    const py = Math.round(cy * (imgH - 1));
    if (radius <= 0) return getLum(px, py);
    let sum = 0;
    let n = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = Math.min(imgW - 1, Math.max(0, px + dx));
        const y = Math.min(imgH - 1, Math.max(0, py + dy));
        sum += getLum(x, y);
        n++;
      }
    }
    return sum / n;
  });
}

/**
 * 連続するレーン輝度プロファイル列から、前進方向のシフト量を積算する。
 * 各隣接ペアで bestShift を取り、相関スコアが minScore 以上かつ前進方向のときだけ採用する。
 * @param {number[][]} profiles 時系列のプロファイル(古い→新しい)
 * @param {{maxLag?:number,minScore?:number,forwardSign?:number}} opts
 *   forwardSign: 前進に対応する lag の符号(+1 または -1)。レーンのスロット順で決まる。
 * @returns {{totalShift:number, advances:number, pairs:number, rejected:number}}
 */
export function accumulateForwardShift(profiles, opts = {}) {
  const maxLag = opts.maxLag ?? 3;
  const minScore = opts.minScore ?? 0.5;
  const forwardSign = opts.forwardSign ?? 1;
  let totalShift = 0;
  let advances = 0;
  let pairs = 0;
  let rejected = 0;
  for (let i = 0; i < profiles.length - 1; i++) {
    pairs++;
    const { lag, score } = bestShift(profiles[i], profiles[i + 1], maxLag);
    if (score < minScore || lag === 0) {
      rejected++;
      continue;
    }
    if (Math.sign(lag) === Math.sign(forwardSign)) {
      totalShift += Math.abs(lag);
      advances++;
    } else {
      rejected++;
    }
  }
  return { totalShift, advances, pairs, rejected };
}
