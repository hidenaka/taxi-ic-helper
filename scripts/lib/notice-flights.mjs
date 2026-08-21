// notice-flights — 現地案内(pool-notice)の遅延便テキストを構造化する純関数。
// 掲示は指導員の手打ちで書式が日々変わるため、2026-06-19〜08-07 の実テキスト84種を
// フィクスチャに、以下のパターン族を拾う:
//   ・号ヘッダ型     【1号乗り場】 / ・3号乗り場側・ / 〇3号 / 4号側 / 2号乗り場
//   ・ターミナル型   ＜第1ターミナル＞ / 第1ターミナル側 / ・第2ターミナル
//   ・単行便         JAL920 沖縄便 23:40 356人 / SF北九州 23:51到着予定 降機客数約100名
//   ・複数行ブロック ANA深圳便 → 到着予定時刻：午前2時頃 → 降機客数：約200人 → 到着出口：4号乗り場
//   ・出口指定行     到着出口：4号乗り場 / 出口→3号側 / 2号側の予定 / 両便共に第4乗り場に…
//   ・合算グループ   遅延便2便ともに午前0時40分頃到着予定。予約人数は2便合わせて約500人
//   ・客列人数       第2乗り場・・・約1,400名 / ・第2乗り場→約70人 / 3号乗り場50人の客列
//   ・消し込み       到着済み / 全便到着済 / まもなく終了
//   ・最終便情報型   SKY730札幌 第2乗り場 → 22:40→0:48到着予定 128人 (号が便名行に併記・2026-08-21初出)
// 読めない行は黙って捨てる(誤抽出より取りこぼしを選ぶ)。

const AIRLINE_RE = /(ANA|JAL|ADO|SKY|SFJ|SNA|BC\d|SF|全日空|日本航空|スカイマーク|ソラシド|エアドゥ|エア・ドゥ|スターフライヤー|ピーチ|ジェットスター)/;

// 全角→半角・記号ゆれの正規化。数字の桁区切りカンマも落とす。
export function normalizeNoticeText(text) {
  if (typeof text !== 'string') return '';
  let t = text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/：/g, ':')
    .replace(/、/g, ',')
    .replace(/[　]/g, ' ')
    .replace(/(\d),(?=\d{3})/g, '$1');
  return t;
}

// 時刻表現 → {text, minutes, approx}。minutes は 0..1799 (24時台=+1440維持で当日深夜扱い)。
// 読めなければ null。「未定」は {text:'未定', minutes:null}。
export function parseEta(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (/未定/.test(t)) return { text: '未定', minutes: null, approx: true };
  // "22:55→23:47" / "22:40→翌1:35" は右側(変更後)を採る
  const arrow = t.split(/→/);
  const target = arrow.length > 1 ? arrow[arrow.length - 1] : t;
  const ampm = /午後/.test(target) ? 12 : 0;
  let m = target.match(/(\d{1,2}):(\d{2})/);
  if (!m) m = target.match(/(\d{1,2})\s*時\s*(\d{1,2})\s*分/);
  let hh; let mm;
  if (m) {
    hh = parseInt(m[1], 10) + ampm;
    mm = parseInt(m[2], 10);
  } else {
    const h = target.match(/(\d{1,2})\s*時(?![\d間])/);
    if (!h) return null;
    hh = parseInt(h[1], 10) + ampm;
    mm = 0;
  }
  if (hh >= 30 || mm >= 60) return null;
  const approx = /頃|過ぎ|予定/.test(target) && !/到着済|着済/.test(target);
  const minutes = hh * 60 + mm;
  const dispH = hh % 24;
  return { text: `${dispH}:${String(mm).padStart(2, '0')}`, minutes, approx };
}

// 人数表現 → number|null。運賃(円)や「2便」は拾わない。
export function parsePax(s) {
  if (typeof s !== 'string') return null;
  // 「N便合わせて」のNや金額を除外するため、[人名]直前の数字だけを見る
  const m = s.match(/(?:約\s*)?(\d{2,5})\s*[人名]/);
  if (!m) return null;
  const v = parseInt(m[1], 10);
  return Number.isFinite(v) && v > 0 && v <= 99999 ? v : null;
}

// 行が乗り場号ヘッダなら号(1-4)を返す。便情報や客列人数の行はヘッダ扱いしない。
export function parseStallHeader(line) {
  const t = line.trim();
  if (parsePax(t) !== null) return null; // 人数付きは客列行
  if (AIRLINE_RE.test(t)) return null;   // 便名付きは便行
  let m = t.match(/^[・〇○◯]?\s*【?\s*第?([1-4])\s*号\s*(?:乗り?場)?\s*(?:側)?\s*】?\s*[・]?\s*$/);
  if (m) return parseInt(m[1], 10);
  // "4号側" 単独 (【遅延便情報】ブロック内の見出し)
  m = t.match(/^([1-4])号側$/);
  if (m) return parseInt(m[1], 10);
  return null;
}

// 行がターミナルヘッダなら 1|2|3 を返す。
export function parseTerminalHeader(line) {
  const t = line.trim();
  const m = t.match(/^[・〇○◯＜<]?\s*第?([1-3])\s*ターミナル\s*(?:側|＞|>)?\s*(.*)$/);
  if (!m) return null;
  // "第1ターミナル側計750人" のような合算行はヘッダではなく groups で扱う
  if (parsePax(m[2]) !== null) return null;
  return parseInt(m[1], 10);
}

// 出口指定行 → 号(1-4)|null。"到着出口：4号乗り場" / "出口→3号側" / "2号側の予定" /
// "両便共に第4乗り場に到着予定です" / "第4乗り場に到着予定です" / "2便共に第3乗り場へ…"
export function parseExitAssign(line) {
  const t = line.trim();
  let m = t.match(/到着出口\s*:?\s*第?([1-4])\s*号/);
  if (m) return { stall: parseInt(m[1], 10), scope: 'prev' };
  m = t.match(/出口\s*→\s*第?([1-4])\s*号/);
  if (m) return { stall: parseInt(m[1], 10), scope: 'prev' };
  m = t.match(/到着出口\s*([1-4])\s*号側/);
  if (m) return { stall: parseInt(m[1], 10), scope: 'prev' };
  m = t.match(/^([1-4])\s*号側の予定/);
  if (m) return { stall: parseInt(m[1], 10), scope: 'prev' };
  m = t.match(/(両便|\d+\s*便)\s*共に\s*第?([1-4])\s*(?:号|乗り場)/);
  if (m) return { stall: parseInt(m[2], 10), scope: 'all' };
  m = t.match(/第?([1-4])\s*乗り場に到着予定/);
  if (m) return { stall: parseInt(m[1], 10), scope: 'prev' };
  return null;
}

// 客列/見込み人数行 → {stalls:[..], pax}|null。
// "第2乗り場・・・約1,400名" / "・第2乗り場→約70人" / "1号 約50人" / "1,3号 約50人" /
// "3号乗り場50人の客列"
export function parseStandPax(line) {
  const t = line.trim();
  if (AIRLINE_RE.test(t)) return null;             // 便行は対象外
  if (/ターミナル/.test(t)) return null;           // ターミナル合算は groups
  const pax = parsePax(t);
  if (pax === null) return null;
  const m = t.match(/^[・〇○◯]?\s*((?:第?[1-4]\s*[,、]?\s*)+)\s*(?:号|乗り場)/);
  if (!m) return null;
  const stalls = (m[1].match(/[1-4]/g) || []).map(Number);
  if (stalls.length === 0) return null;
  return { stalls, pax };
}

// 便行内に号が併記される形式(「SKY730札幌 第2乗り場」最終便情報型・2026-08-21初出)
function parseInlineStall(t) {
  const m = t.match(/第\s*([1-4])\s*乗り場(?:側)?|([1-4])\s*号\s*乗り場(?:側)?/);
  return m ? parseInt(m[1] || m[2], 10) : null;
}

function stripInlineStall(t) {
  return t.replace(/第\s*[1-4]\s*乗り場(?:側)?|[1-4]\s*号\s*乗り場(?:側)?/g, ' ').replace(/\s+/g, ' ').trim();
}

const ARRIVED_RE = /到着済|着済/;

// 到着済みか。「済」明記のほか、「…到着。」「…到着」で終わり予定でない文も済み扱い
// ("午前0時25分到着。" は済み / "午前0時46分到着予定。" は未着)。
function isArrivedText(t) {
  if (ARRIVED_RE.test(t)) return true;
  return /到着\s*。?\s*$/.test(t.trim()) && !/予定/.test(t);
}

// 便行(単行型) → {name, eta, pax, arrived}|null。
// 便名(航空会社トークン)を含み、時刻か人数のどちらかがあれば便として拾う。
function parseFlightLine(line) {
  const t = line.trim();
  if (!AIRLINE_RE.test(t)) return null;
  if (/に関しては|連絡はまだ|詳細は不明/.test(t)) return null; // 注記文は捨てる
  const eta = parseEta(t);
  const pax = parsePax(t);
  if (!eta && pax === null) return null;
  // 便名 = 行頭から時刻/人数/区切りの手前まで
  let name = t;
  const cutAt = t.search(/午前|午後|\d{1,2}[:時]\d{0,2}|約\s*\d|降機客数|搭乗人数|予約人数|人数|時刻未定|未定/);
  if (cutAt > 0) name = t.slice(0, cutAt);
  name = stripInlineStall(name);
  name = name.replace(/^最終便/, '').replace(/は$/, '').replace(/[ \t・、,]+$/, '').replace(/\s+/g, ' ').trim();
  if (!name || !AIRLINE_RE.test(name)) return null;
  return { name, eta: eta ?? null, pax, arrived: isArrivedText(t), inlineStall: parseInlineStall(t) };
}

// 便名だけの行(複数行ブロックの先頭) → 名前|null。"ANA深圳便" / "全日空 深圳便" / "・SKY522沖縄"
function parseFlightNameOnly(line) {
  const t = line.trim().replace(/^[・]/, '').trim();
  if (!AIRLINE_RE.test(t)) return null;
  if (parseEta(t) || parsePax(t) !== null) return null; // 単行型は parseFlightLine の領分
  if (t.length > 25) return null; // 長文は注記
  if (/に関しては|不足|状況|規制/.test(t)) return null;
  return stripInlineStall(t).replace(/\s+/g, ' ');
}

// 属性行(複数行ブロックの2行目以降)。到着予定時刻:/降機客数:/事後請求 等。
function parseAttrLine(line) {
  const t = line.trim();
  if (/^到着(予定)?時刻/.test(t)) {
    const eta = parseEta(t);
    return eta ? { eta } : null;
  }
  if (/^(降機客数|搭乗人数|人数|予約人数)/.test(t)) {
    const pax = parsePax(t);
    return pax !== null ? { pax } : {};
  }
  if (/^事後請求/.test(t)) return {};
  // "約320人" 単独行(号ヘッダブロック内の人数行)
  if (/^約?\s*\d{2,5}\s*[人名]$/.test(t)) {
    const pax = parsePax(t);
    if (pax !== null) return { pax };
  }
  // "午前0時48分到着予定" の時刻単独行、"22:40→0:48到着予定 128人" の時刻+人数行(最終便情報型)
  const eta = parseEta(t);
  if (eta && /到着|予定|着/.test(t) && !AIRLINE_RE.test(t)) {
    const pax = parsePax(t);
    return pax !== null ? { eta, pax, arrived: isArrivedText(t) } : { eta, arrived: isArrivedText(t) };
  }
  return null;
}

// 合算グループ行。"遅延便2便ともに午前0時40分頃到着予定" / "予約人数は2便合わせて約500人" /
// "第1ターミナル側計750人" / "遅れ便有り 2便共に第3乗り場へ午前0時到着予定"
function parseGroupLine(line) {
  const t = line.trim();
  let m = t.match(/第([1-3])ターミナル側?\s*計\s*(\d{2,5})\s*[人名]/);
  if (m) return { terminal: parseInt(m[1], 10), pax: parseInt(m[2], 10), count: null };
  m = t.match(/(遅延便|遅れ便|)(\d)\s*便\s*(?:ともに|共に|合わせて)/);
  if (m && /便/.test(t)) {
    const count = parseInt(m[2], 10);
    const eta = parseEta(t);
    const pax = parsePax(t);
    const stall = (t.match(/第?([1-4])\s*(?:号|乗り場)/) || [])[1];
    if (eta || pax !== null) {
      return {
        count,
        eta: eta ?? null,
        pax,
        stall: stall ? parseInt(stall, 10) : null,
      };
    }
  }
  // "遅延便1便が午前0時50分頃到着予定" (単数)
  m = t.match(/遅延便\s*(\d)\s*便が/);
  if (m) {
    const eta = parseEta(t);
    if (eta) return { count: parseInt(m[1], 10), eta, pax: parsePax(t), stall: null };
  }
  return null;
}

/**
 * 遅延便テキスト全体をパースする。入口。
 * @param {string} rawText pool-notice の flightNoticeText (liveText)
 * @returns {{flights:Array, groups:Array, standPax:Array, allClear:boolean, endingSoon:boolean}}
 */
export function parseFlightNotice(rawText) {
  const out = { flights: [], groups: [], standPax: [], allClear: false, endingSoon: false };
  const text = normalizeNoticeText(rawText);
  if (!text) return out;

  let ctx = { stall: null, terminal: null };
  let block = null; // 複数行ブロックの構築途中の便
  let lastGroup = null; // 直前の合算グループ(人数が次行に来る書式)

  const flushBlock = () => {
    if (block && (block.eta || block.pax !== null)) out.flights.push(block);
    block = null;
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^---$/.test(line)) { ctx = { stall: null, terminal: null }; flushBlock(); continue; }

    // 全体状態
    if (/全便(到着済|終了|手荷物受取終了)/.test(line)) { out.allClear = true; flushBlock(); continue; }
    if (/まもなく終了|間もなく終了/.test(line)) { out.endingSoon = true; flushBlock(); continue; }

    // ヘッダ(号/ターミナル)
    const stall = parseStallHeader(line);
    if (stall !== null) { flushBlock(); ctx = { stall, terminal: ctx.terminal }; continue; }
    const term = parseTerminalHeader(line);
    if (term !== null) { flushBlock(); ctx = { stall: null, terminal: term }; continue; }

    // 出口指定 → 遡って割り当て
    const exit = parseExitAssign(line);
    if (exit) {
      const hadPending = Boolean(block)
        || out.flights.some((f) => f.stall == null)
        || out.groups.some((g) => g.stall == null);
      if (block) block.stall = exit.stall;
      flushBlock();
      if (exit.scope === 'all') {
        for (const f of out.flights) if (f.stall == null) f.stall = exit.stall;
        for (const g of out.groups) if (g.stall == null) g.stall = exit.stall;
      } else {
        for (let i = out.flights.length - 1; i >= 0; i--) {
          if (out.flights[i].stall == null) { out.flights[i].stall = exit.stall; break; }
        }
      }
      // "遅れ便有り 2便共に第3乗り場へ午前0時到着予定" — 割り当て先が無い出口行は
      // それ自体が匿名グループ(便数+時刻)なので groups として拾い直す
      if (!hadPending) {
        const eta = parseEta(line);
        const cm = line.match(/(\d)\s*便\s*共に/);
        if (eta) {
          const g = { count: cm ? parseInt(cm[1], 10) : null, eta, pax: parsePax(line), stall: exit.stall };
          out.groups.push(g);
          lastGroup = g;
        }
      }
      continue;
    }

    // 合算グループ
    const grp = parseGroupLine(line);
    if (grp) {
      flushBlock();
      if (grp.stall == null && ctx.stall != null) grp.stall = ctx.stall;
      if (grp.terminal == null && ctx.terminal != null && grp.stall == null) grp.terminal = ctx.terminal;
      // "遅延便2便ともに0:40到着予定" → "予約人数は2便合わせて約500人" の後追い人数は
      // 直前グループへの補完(別グループにしない)
      if (lastGroup && grp.pax != null && grp.eta == null && lastGroup.pax == null
          && (grp.stall == null || grp.stall === lastGroup.stall)
          && (grp.count == null || grp.count === lastGroup.count)) {
        lastGroup.pax = grp.pax;
      } else {
        // 便リストの後追い合算("2便合わせて約500人")は便数を二重に数えない
        if (grp.pax != null && grp.eta == null && grp.count != null) {
          const covered = out.flights.filter((f) => f.stall === grp.stall && f.pax == null).length;
          if (covered >= grp.count) grp.coversFlights = true;
        }
        out.groups.push(grp);
        lastGroup = grp;
      }
      continue;
    }
    // グループのeta後追い: "最終便は午前1時着予定"
    if (lastGroup && /^最終便/.test(line)) {
      const eta = parseEta(line);
      if (eta && !lastGroup.eta && !AIRLINE_RE.test(line)) { lastGroup.eta = eta; continue; }
    }
    // グループの人数だけ後から来る書式: "予約人数は2便合わせて約500人" は parseGroupLine が拾うが、
    // "予約人数は約150人" は直前グループ/便への補完
    if (/^予約人数|^搭乗人数|^降機客数/.test(line) && !AIRLINE_RE.test(line)) {
      const pax = parsePax(line);
      if (pax !== null) {
        if (block) { block.pax = block.pax ?? pax; continue; }
        if (lastGroup && lastGroup.pax == null) { lastGroup.pax = pax; continue; }
        const last = out.flights[out.flights.length - 1];
        if (last && last.pax == null) { last.pax = pax; continue; }
      }
      continue;
    }

    // 客列人数
    const sp = parseStandPax(line);
    if (sp) { flushBlock(); out.standPax.push(sp); continue; }

    // 便(単行)
    const fl = parseFlightLine(line);
    if (fl) {
      flushBlock();
      fl.stall = fl.inlineStall ?? ctx.stall;
      delete fl.inlineStall;
      fl.terminal = ctx.terminal;
      out.flights.push(fl);
      lastGroup = null;
      continue;
    }

    // 便(ブロック先頭: 便名のみ)
    const name = parseFlightNameOnly(line);
    if (name) {
      flushBlock();
      block = { name, eta: null, pax: null, arrived: false, stall: parseInlineStall(line) ?? ctx.stall, terminal: ctx.terminal };
      lastGroup = null;
      continue;
    }

    // ブロック属性行
    if (block) {
      const attr = parseAttrLine(line);
      if (attr) {
        if (attr.eta && !block.eta) block.eta = attr.eta;
        if (typeof attr.pax === 'number' && block.pax == null) block.pax = attr.pax;
        if (attr.arrived) block.arrived = true;
        continue;
      }
    }
    // どのパターンにも合わない行は捨てる(誤抽出しない)
  }
  flushBlock();

  // 到着済みの重複掲示(同名・同時刻)を一本化
  const seen = new Set();
  out.flights = out.flights.filter((f) => {
    const k = `${f.name}|${f.eta?.text ?? ''}|${f.pax ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return out;
}

/**
 * パース結果を号別サマリにする(アプリ表示用の集計)。
 * 未着(arrived=false)の便/グループだけを数える。号不明はterminal別に。
 * @returns {{byStall:Record<string,{pendingPax:number,pendingFlights:number,nextEta:string|null}>,
 *           byTerminal:Record<string,{pendingPax:number,pendingFlights:number}>,
 *           queue:Record<string,number>, allClear:boolean}}
 */
export function summarizeFlightNotice(parsed) {
  const byStall = {};
  const byTerminal = {};
  const queue = {};
  const add = (map, key, pax, count, etaMin, etaText) => {
    const e = (map[key] = map[key] || { pendingPax: 0, pendingFlights: 0, nextEta: null, _min: Infinity });
    e.pendingPax += pax ?? 0;
    e.pendingFlights += count;
    // 掲示は深夜帯(22時〜2時)のもの。0時台〜昼前の時刻は日またぎ後として23時台より後に並べる
    const sortMin = etaMin != null && etaMin < 720 ? etaMin + 1440 : etaMin;
    if (sortMin != null && sortMin < e._min) { e._min = sortMin; e.nextEta = etaText; }
  };
  for (const f of parsed.flights) {
    if (f.arrived) continue;
    const key = f.stall != null ? f.stall : null;
    if (key != null) add(byStall, key, f.pax, 1, f.eta?.minutes, f.eta?.text);
    else if (f.terminal != null) add(byTerminal, f.terminal, f.pax, 1, f.eta?.minutes, f.eta?.text);
  }
  for (const g of parsed.groups) {
    if (g.stall != null) add(byStall, g.stall, g.pax, g.coversFlights ? 0 : (g.count ?? 1), g.eta?.minutes, g.eta?.text);
    else if (g.terminal != null) add(byTerminal, g.terminal, g.pax, g.count ?? 1, g.eta?.minutes, g.eta?.text);
  }
  for (const s of parsed.standPax) {
    // 複数号の合算(1,3号 約50人)は代表値として各号へ同値(過大側だが客列は目安表示のみ)
    for (const st of s.stalls) queue[st] = Math.max(queue[st] ?? 0, s.pax);
  }
  for (const m of [byStall, byTerminal]) for (const k of Object.keys(m)) delete m[k]._min;
  return { byStall, byTerminal, queue, allClear: parsed.allClear };
}
