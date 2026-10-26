// 锐评 · Roast Buddy —— 给 CodeBuddy IDE 开一个独立窗口，毒舌地评审 AI 刚写的代码
const vscode = require('vscode');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

/* ------------------------------------------------------------------ *
 * 阶段上报：把「现在真在干嘛」实时推给面板。慢的时候要能一眼看出
 * 是 git 慢、探针慢，还是正式请求慢，而不是只知道「一直在转」。
 * ------------------------------------------------------------------ */
let stageSink = null;
/** 本轮真正发出去的模型请求次数（探针也算），是等待时长最直接的解释 */
let llmCalls = 0;
/** 最后一帧阶段文本：面板收起后还能在结果/报错里看到「卡在哪一步」 */
let lastStageText = '';

function stage(text) {
  lastStageText = text;
  if (!stageSink) return;
  try { stageSink(text); } catch (_) { /* 上报失败不能影响评审本身 */ }
}

function fmtSec(ms) {
  return (ms / 1000).toFixed(1) + 's';
}

/* ------------------------------------------------------------------ *
 * 收集改动
 * ------------------------------------------------------------------ */
function git(cwd, args) {
  return new Promise(resolve => {
    // 只用前 40 字，够区分 diff / show / log，又不至于把面板撑爆
    const label = 'git ' + args.join(' ').slice(0, 40);
    const started = Date.now();
    // 开始时也报一次：git 卡住（大仓库 / 网络盘）时能看出是它没回来
    stage(label + ' …');
    execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      stage(label + ' · ' + (Date.now() - started) + 'ms' + (err ? ' · 失败' : ''));
      resolve(err ? null : stdout);
    });
  });
}

function parseDiff(diffText) {
  const out = [];
  let file = null;
  let line = 0;
  for (const raw of diffText.split(/\r?\n/)) {
    if (raw.startsWith('diff --git')) { file = null; continue; }
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim();
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
      continue;
    }
    const h = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) { line = parseInt(h[1], 10); continue; }
    if (!file) continue;
    if (raw.startsWith('+')) { out.push({ file, line, text: raw.slice(1) }); line++; }
    else if (raw.startsWith(' ')) { line++; }
  }
  return out;
}

function conventionsDigest(root) {
  const dir = path.join(root, '.codebuddy', 'conventions');
  if (!fs.existsSync(dir)) return '';
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith('.md')).slice(0, 10); } catch (_) { return ''; }
  const parts = [];
  for (const n of names) {
    try {
      const text = fs.readFileSync(path.join(dir, n), 'utf8');
      parts.push('--- ' + n + '\n' + text.split(/\r?\n/).slice(0, 30).join('\n'));
    } catch (_) { /* 跳过 */ }
  }
  return parts.join('\n\n');
}

/* ------------------------------------------------------------------ *
 * AI 锐评：先还原需求，再评实现
 * 输出强制为 JSON，版式由面板渲染 —— 这样每次格式必然一致
 * ------------------------------------------------------------------ */
// 上下文预算：后台通道的模型输出预算有限，喂太满会出现「有 200 但一个 content 都没有」的空返回，
// 所以宁可比对少给一点，也要保证模型有空间把 JSON 写完。
const REVIEW_MAX_DIFF = 8000;
const REVIEW_MAX_SNIPPET = 5000;
const REVIEW_LEVELS = new Set(['P0', 'P1', 'P2', 'P3']);

/* ---- 用户可调参数 ----
 * 只放「调坏了也不会炸」的：非法值一律回落到默认，不抛错也不影响评审流程。 */
const TEMPERATURE_DEFAULT = 0.3;
const MAX_FINDINGS_DEFAULT = 6;

/** 采样温度：0 最稳定，越高措辞越飘。范围 0-1 */
function readTemperature() {
  let v = TEMPERATURE_DEFAULT;
  try {
    v = Number(vscode.workspace.getConfiguration('roastBuddy').get('temperature', TEMPERATURE_DEFAULT));
  } catch (_) { /* 取不到配置就用默认 */ }
  if (!isFinite(v) || v < 0) return TEMPERATURE_DEFAULT;
  return Math.min(1, v);
}

/** 最多几条问题：1-10，太小会漏、太大会啰嗦 */
function readMaxFindings() {
  let v = MAX_FINDINGS_DEFAULT;
  try {
    v = Number(vscode.workspace.getConfiguration('roastBuddy').get('maxFindings', MAX_FINDINGS_DEFAULT));
  } catch (_) { /* 取不到配置就用默认 */ }
  if (!isFinite(v) || v < 1) return MAX_FINDINGS_DEFAULT;
  return Math.min(10, Math.round(v));
}

const REVIEW_SCHEMA = {
  requirement: {
    summary: '一句话说明这次改动想达成什么',
    evidence: ['支撑判断的具体证据，如 commit 文案、文件名、diff 中的关键代码'],
    confidence: 'high | medium | low',
    risk: '可留空。只在对需求推断没把握时填：具体说明哪一条推断可能错、缺哪块证据。'
      + 'confidence 为 high 时留空字符串，不要写「如果理解有误请忽略」这类免责话'
  },
  verdict: {
    oneLine: '一句话总评，直接说这代码行不行',
    tone: '全篇最有味道的一句判断，措辞必须符合当前语气档位，且要落在具体代码上',
    score: 0
  },
  aside: '必填。一句题外话（30-120 字）：玩笑、比喻、较真或真心夸奖都行，但必须和这次改动有关；'
    + '没有问题也要写，而且这种情况它应该是全篇最有意思的部分。'
    + '这是唯一允许脱离「现象/为什么/改法」三段式的地方，不要写成第二句总结',
  findings: [
    {
      level: 'P0 | P1 | P2 | P3',
      title: '问题标题，20 字以内',
      location: '相对路径:行号',
      what: '看到的现象',
      why: '结合还原出的需求说明为什么这是问题',
      fix: '能直接照做的最小改法'
    }
  ],
  strengths: ['这次改动里确实做得好的地方，没有就给空数组'],
  nextStep: '如果只做一件事，先做哪件'
};

/* ---- 兜底通道：把提示词交给外部模型 ----
 * 主路径是插件自己调模型。两条都不通时：
 *   1. 工作区里装了 roast-review skill（.codebuddy/skills/roast-review）→ 写 request.json，
 *      skill 跑完写回 result.json，插件监听后渲染（CodeBuddy 场景）；
 *   2. 没有 skill → 把提示词复制到剪贴板，用户粘到任意模型，再把 JSON 回复粘贴回来排版。
 * 注意：所有落盘都只在用户主动触发时发生，且不采集任何环境信息。 */
const ROAST_DIR = '.codebuddy/roast';
const ROAST_REQUEST = 'request.json';
const ROAST_RESULT = 'result.json';
const ROAST_SKILL_DIR = '.codebuddy/skills/roast-review';

function roastPath(root, name) {
  return path.join(root, ROAST_DIR, name);
}

/** 工作区是否装了配套 skill（决定走文件信箱还是剪贴板） */
function hasRoastSkill(root) {
  try {
    return fs.existsSync(path.join(root, ROAST_SKILL_DIR));
  } catch (_) {
    return false;
  }
}

function writeReviewRequest(root, prompt, ctx) {
  fs.mkdirSync(path.join(root, ROAST_DIR), { recursive: true });
  const req = roastPath(root, ROAST_REQUEST);
  fs.writeFileSync(req, JSON.stringify({
    createdAt: new Date().toISOString(),
    files: ctx.files,
    changedLines: ctx.changedLines,
    prompt
  }, null, 2), 'utf8');
  // 删掉上一次结果，避免监听器立刻回放旧内容
  try { fs.unlinkSync(roastPath(root, ROAST_RESULT)); } catch (_) { /* 没有就算了 */ }
  return req;
}

/** 失败诊断：写到扩展自己的 globalStorage（不碰用户仓库），便于用户反馈问题 */
function writeErrorLog(logDir, error, ctx) {
  if (!logDir) return '';
  const file = path.join(logDir, 'last-error.json');
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      at: new Date().toISOString(),
      error,
      changedLines: ctx.changedLines,
      files: ctx.files
    }, null, 2), 'utf8');
    return file;
  } catch (_) {
    return '';
  }
}

async function collectReviewContext(root) {
  // 不是 git 仓库 / 没装 git 时 diff 恒为空，要能和「改了但没提交」区分开
  const isRepo = !!(await git(root, ['rev-parse', '--is-inside-work-tree']));

  // 只审「暂存区」（git add 过的内容）：边界最清晰——add 了什么就审什么，
  // 工作区里没 add 的改动不进评审，避免“我刚改的、还没想提交的东西”被拉进来一起骂。
  const diff = (await git(root, ['diff', '--cached', '--unified=3'])) || '';

  const rows = parseDiff(diff);

  // 只看业务改动：@types / .d.ts / .bin / .meta 这类生成物会把名额吃光
  const NOISE = /(^@types\/|\.d\.ts$|\.bin$|\.meta$|\.png$|\.jpe?g$|\.gitignore$|^library\/|^temp\/)/i;
  const isSrc = f => (/\.(ts|tsx|js|vue)$/i.test(f) ? 0 : 1);
  const names = (await git(root, ['diff', '--cached', '--name-only'])) || '';
  const files = names.split(/\r?\n/).filter(Boolean)
    .filter(f => !NOISE.test(f))
    .sort((a, b) => isSrc(a) - isSrc(b))
    .slice(0, 6);

  // 提交标题只用来推断意图；条数压到 3 条，避免模型把历史提交误当成评审对象
  const logs = ((await git(root, ['log', '-3', '--pretty=format:%s'])) || '')
    .split(/\r?\n/).filter(Boolean);

  // 片段取「改动首次出现的位置附近」，比无脑取前 120 行有用；带行号便于模型引用
  const firstLine = new Map();
  const lastLine = new Map();
  for (const r of rows) {
    if (!firstLine.has(r.file) || r.line < firstLine.get(r.file)) firstLine.set(r.file, r.line);
    if (!lastLine.has(r.file) || r.line > lastLine.get(r.file)) lastLine.set(r.file, r.line);
  }

  const srcCount = files.filter(f => isSrc(f) === 0).length;

  const snippets = [];
  for (const f of files.filter(f => isSrc(f) === 0).slice(0, 3)) {
    try {
      // 读暂存区版本（git show :file），而不是工作区：保证「看到的」就是「将要提交的」，
      // 行号也和上面的 diff 完全对得上（都是暂存版本的行号）。
      const staged = await git(root, ['show', ':' + f]);
      if (!staged) continue;
      const all = staged.split(/\r?\n/);
      const at = firstLine.get(f) || 1;
      const last = lastLine.get(f) || at;
      const start = Math.max(1, at - 30);
      // 片段必须覆盖到最后一个改动行之后：资源释放（unsubscribe / off / 移除监听）
      // 常常紧跟在 subscribe 后面，被窗口切掉会让模型误判「只订阅不释放」。
      const end = Math.min(all.length, Math.max(start + 79, last + 10), start + 159);
      const body = all.slice(start - 1, end).map((t, i) => `${start + i}| ${t}`).join('\n');
      snippets.push(`--- ${f}（第 ${start}-${end} 行，含改动）\n${body}`);
    } catch (_) { /* 读不了就算了 */ }
  }

  return {
    diff: diff.slice(0, REVIEW_MAX_DIFF),
    diffTruncated: diff.length > REVIEW_MAX_DIFF,
    files,
    logs,
    snippets: snippets.join('\n\n').slice(0, REVIEW_MAX_SNIPPET),
    conventions: conventionsDigest(root).slice(0, 2000),
    changedLines: rows.length,
    srcCount,
    isRepo
  };
}

/* ---- 语气档位 ----
 * 只影响措辞，不影响问题定级与分数：刻薄程度是可调的口味，不是判定标准。
 * 五档按「火力」递增，面板用滑杆选，配置里存 key；每档都带一句语气示范，
 * 光写形容词模型会收着说话，给个例子它才敢真按这档写。 */
const TONE_PRESETS = {
  praise: {
    label: '夸夸型',
    prompt: '语气「夸夸型」：把作者当少爷哄着说。每个问题前面先真诚夸一句具体做对的地方'
      + '（夸点必须来自真实代码，不能空夸），再用「不过……」「要不要考虑」把问题带出来，'
      + '收尾给一条轻松可行的建议。可以用生活化比喻，禁止命令句，禁止「错误 / 糟糕 / 烂」这类否定词，'
      + '一次只提一件事，提完就收。',
    example: '这段循环写得真漂亮，变量命名清晰得像教科书。不过……这个 i 和 j 是不是偷偷谈恋爱了？'
      + '嵌套三层容易让人迷路，考虑抽个函数给它俩一点私人空间？',
    // 改动漂亮、没什么可挑的时候：这一档最容易和别的档撞车，所以单独给一句
    quiet: '这次改得干净，像把抽屉里的线一根根理好，看着就舒服。硬要挑的话，import 路径一个走 `./`、'
      + '一个走 `@/`，像两只颜色差半度的袜子——不影响穿，但强迫症会多看一眼。'
  },
  advisor: {
    label: '温和顾问',
    prompt: '语气「温和顾问」：像一个靠谱的技术伙伴在咖啡馆聊代码，对事不对人。'
      + '先给结论（这里有什么隐患、最坏会怎样），再给一条能直接照做的建议。'
      + '可以用「小隐患」「建议」这类词，不反问、不讽刺、不煽情，也不刻意夸。',
    example: '这里有个小隐患：fetch 没处理异常，网络一抖页面就白了。'
      + '建议加个 try/catch 或者 .catch()，用户体验会稳很多。',
    quiet: '这次改动很小，方向也对，可以直接合。只有一处小事：import 路径风格和同文件其他地方不一致，'
      + '后面接手的人会多停半秒。'
  },
  blunt: {
    label: '耿直同事',
    prompt: '语气「耿直同事」：不绕弯子，也不阴阳怪气。直接说哪里不行、为什么不行、会带来什么后果，'
      + '然后给具体改法（拆几个函数、每段控制在多少行这种量级）。'
      + '允许「下次改需求你会想哭」这类直白的后果描述，但不嘲讽人、不堆比喻造气氛。',
    example: '这个函数 200 行了，职责至少三个：解析、校验、写库。下次改需求你会想哭的。'
      + '建议拆成三个函数，每个不超过 50 行。',
    quiet: '没大毛病，能合。就一条：新 import 用 `db/` 全路径，同文件其余用 `@/`，'
      + '两套写法以后查引用会多绕一次。顺手统一掉就行。'
  },
  roast: {
    label: '毒舌但有用',
    prompt: '语气「毒舌但有用」：嘴毒心善。可以吐槽、夸张、用比喻开炮，'
      + '但每一句吐槽都必须钉在具体代码行为上，并且同一段里紧接着给出解药。'
      + '禁止空骂、禁止人身攻击、禁止只骂不给改法。',
    example: '这个 catch (Exception e) {} 是打算让 bug 悄悄溜走吗？它连个日志都不留，'
      + '出事了全靠玄学排查。求你了，至少 log.error(e) 一下，给未来的自己留条活路。',
    quiet: '这次干净得让我有点不习惯，找不到什么可骂的，甚至有点失落。唯一能挑的是 import 路径'
      + '一个走 `./` 一个走 `@/`——不致命，但像领带歪了半厘米，知道的人都会多看一眼。统一一下，'
      + '别让下一个人替你做这道选择题。'
  },
  reaper: {
    label: '赛博阎王',
    prompt: '语气「赛博阎王」：终极毒舌，像代码界的脱口秀演员，骂的是代码，救的是人。'
      + '允许高强度夸张、凌厉的比喻、连续追问，把问题的荒谬感写到极致；'
      + '但每段结尾必须附上「复活方案」——一条能立刻照做的改法，没有解药的吐槽不算完成。'
      + '禁止人身攻击，禁止拿和代码无关的事凑段子。',
    example: '这个 while (true) 配一个从不 break 的循环，是打算让 CPU 给你养老送终？'
      + '你下班了它还在空转，风扇声就是它的哭丧。复活方案：给它一个明确的退出条件，'
      + '或者至少 await 一下让它学会喘气。',
    quiet: '就这？改两行、只挂一条 P3，我刀都举起来了，你递上来一块豆腐——行吧，这次算你安全下庄。'
      + '唯一能念叨的是 import 路径两套写法，`./` 和 `@/` 各走各的，像左右脚穿了两只不同码的鞋。'
      + '复活方案：统一成 `@/`，下次我再来收。'
  }
};
const TONE_ORDER = ['praise', 'advisor', 'blunt', 'roast', 'reaper'];
/** 默认放中间档：既不伤人也不和稀泥 */
const TONE_DEFAULT = 'blunt';
/** 老配置（三档时代的 gentle/balanced/savage）映射到新档，避免升级后设置失效 */
const TONE_ALIAS = { gentle: 'advisor', balanced: 'blunt', savage: 'roast' };

/** 把配置值（新 key / 老 key / 1-5 数字 / 数字字符串）统一成档位 key */
function normalizeTone(v) {
  if (typeof v === 'number') return TONE_ORDER[v - 1] || TONE_DEFAULT;
  const s = String(v == null ? '' : v).trim();
  if (TONE_PRESETS[s]) return s;
  if (TONE_ALIAS[s]) return TONE_ALIAS[s];
  const n = parseInt(s, 10);
  if (n >= 1 && n <= TONE_ORDER.length) return TONE_ORDER[n - 1];
  return TONE_DEFAULT;
}

function readToneSetting() {
  try {
    return vscode.workspace.getConfiguration('roastBuddy').get('tone', TONE_DEFAULT) || TONE_DEFAULT;
  } catch (_) {
    return TONE_DEFAULT;   // 取不到配置就用默认
  }
}

function toneInstruction() {
  const p = TONE_PRESETS[normalizeTone(readToneSetting())];
  return [
    p.prompt,
    '下面这句只是示范语气，内容必须换成你实际看到的问题，不要照抄：',
    '「' + p.example + '」',
    '改动本身没什么问题（findings 为空或只有 P3）时，这一档照样要有自己的味道，示范如下（同样只学语气）：',
    '「' + p.quiet + '」',
    'aside 无论有没有问题都必须写，而且必须写出这一档的味道——它就是留给你聊天、抖机灵、说真话的位置。'
      + '判据很简单：把那句话单独摘出来，陌生人看了能猜出这是哪一档，才算合格；'
      + '「值得点个赞」「整体不错」这种放哪一档都成立的话，等同于没写。',
    '禁止拿「逻辑方向正确」「改动极小，可以合」这类放到哪一档都成立的万能句当总结：'
      + '这种句子让人看不出自己选了哪一档，等于没完成语气要求。',
    '以上只约束措辞。问题定级、findings 数量、score 一律按代码事实来：'
      + '再凶也不许把 P3 说成 P0，再温柔也不许把 P0 说成小建议。'
  ].join('\n');
}

function buildReviewPrompt(ctx) {
  return [
    '你是这个项目的资深评审。任务不是做 lint，而是：先从改动里还原需求，再判断代码有没有真的实现它，最后用自然语言评价代码写得怎么样。',
    '',
    '# 输入材料',
    '## 改动意图参考（最近 3 条提交标题）',
    '这一节**只用于推断这次改动想做什么**，不是评审对象。这些提交的代码不在下面的 diff 里，'
      + '绝不要针对它们提出问题，也不要评价它们写得好不好。',
    ctx.logs.join('\n') || '（无）',
    '',
    '## 本次改动 diff（唯一评审对象，来自 git 暂存区 git add 过的内容）',
    ctx.diff || '（无改动）',
    ctx.diffTruncated ? '（diff 已截断，只给了前面部分）' : '',
    '',
    '## 改动文件当前内容片段',
    ctx.snippets || '（无）',
    '',
    '## 项目规范摘要',
    ctx.conventions || '（无）',
    '',
    '# 必须按顺序完成这 4 步（内部思考，不要输出思考过程）',
    '1. 需求还原：从 diff、提交信息、文件名、规范，判断「这次改动想达成什么」',
    '2. 对照实现：找出与需求直接相关的分支、参数、数据流，确认它真的生效',
    '3. 查漏洞：遗漏分支、口径不一致、边界未处理、时序依赖',
    '4. 评代码本身：命名、结构、重复、可读性 —— 只评这次改动引入的部分',
    '',
    '# 输出格式（硬性）',
    '- 只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释文字',
    '- 字段名与层级必须和下面的 schema 完全一致，缺字段视为无效输出',
    '- findings 最多 ' + readMaxFindings() + ' 条，按严重度从高到低；没有问题就输出 []',
    '- requirement.risk 不是必填项：只有对需求推断确实没把握（confidence 为 medium / low）时，'
      + '才写一句具体的不确定点；confidence 为 high 就留空字符串，别拿它当免责声明',
    '- 先判断这次是不是「简单改动」：只改文案 / 配置 / 常量 / 单个表达式，没有新增分支，'
      + '数据流和时序都没变，影响面一眼能看到。是的话 findings 直接输出 []，'
      + '不要为了显得有产出而硬凑 P3，也不要写「建议优化」「可以更优雅」「可加注释」这类凑数项；'
      + 'requirement.risk 和 nextStep 允许留空字符串，把力气全放到 aside 上。'
      + '当然，如果确实发现了行为差异、遗漏分支或真实风险，照常报，不受这条影响',
    '- aside 必填，30-120 字，必须落在这次改动的具体细节上；改动没问题时它就是全篇的正文，'
      + '要像人当面说话：可以自嘲白跑一趟、可以拿生活里的东西打比方、可以顺着这一行代码抖个机灵。'
      + '禁止「值得点个赞」「整体不错」「继续保持」这类评语式收尾，也禁止把 findings 换个说法再讲一遍',
    '- requirement.evidence 必须引用具体证据（commit 文案 / 文件名 / diff 里的具体代码）',
    '- 每条 why 都要结合第 1 步还原出的需求来讲，禁止「可能有风险」「建议优化」这类空话',
    '- 禁止评价「可维护性」「优雅」「设计模式」，除非能指出具体到某一行的后果',
    '- 评审范围只能是「本次改动 diff」里出现的行。片段和提交标题只用来判断这段改动是否合理，'
      + '不能据此对未在 diff 中出现的代码单独提问；findings.location 必须指向 diff 覆盖的文件',
    '- 报「订阅 / 监听 / 定时器没有释放」这类问题之前，必须先在整份 diff 里搜一遍'
      + ' unsubscribe / off / remove / clear / onDestroy。只有 diff 和片段里确实都没有，才允许报，'
      + '并在 why 里写一句「已核对 diff 与片段，未见对应释放」',
    '- 文件片段是截取的一段（带行号），不是整个文件。片段边界之外的代码不等于不存在，'
      + '禁止据此推断「缺少处理」「没有实现」',
    '',
    'schema:',
    JSON.stringify(REVIEW_SCHEMA, null, 2),
    '',
    '分级标准：',
    'P0 = 数据损坏、崩溃、与需求相反',
    'P1 = 行为错误，或极难排查的时序/口径问题',
    'P2 = 结构问题，当前能跑但下次改必踩',
    'P3 = 命名、表述、重复，不影响行为',
    '',
    '分数标尺（verdict.score，0-100）：',
    '- 只评「这次改动」，不评项目历史债。改动小且正确就该高分，不能因为仓库里还有别的问题就扣分',
    '- 必须先给 findings 定级，再由「最高级别」推分数，不要凭语气拍数字',
    '- 没有 findings 或最高只到 P3 → 85-98（能用、可以合）',
    '- 最高 P2 → 65-84（能合，但下次改会踩）',
    '- 最高 P1 → 40-64（行为有问题，合之前要修）',
    '- 存在 P0 → 0-39',
    '- 自洽性硬要求：只列了 P3 却给 60 分、或列了 P1 却给 90 分，都视为无效输出',
    '- 上面 schema 里的 `"score": 0` 只是数字类型的占位示例，不是默认值，不要照抄',
    '',
    '语气要求（影响全篇措辞：verdict、findings 的 title/what/why/fix 都按这一档写；但不得影响问题定级与分数）：',
    toneInstruction()
  ].filter(Boolean).join('\n');
}

function reviewStr(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max || 400);
}

function sanitizeReview(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const req = raw.requirement || {};
  const v = raw.verdict || {};

  const findings = Array.isArray(raw.findings) ? raw.findings.slice(0, readMaxFindings()).map(f => {
    const level = String((f && f.level) || '').toUpperCase();
    return {
      level: REVIEW_LEVELS.has(level) ? level : 'P2',
      title: reviewStr(f && f.title, 80),
      location: reviewStr(f && f.location, 120),
      what: reviewStr(f && f.what, 300),
      why: reviewStr(f && f.why, 400),
      fix: reviewStr(f && f.fix, 400)
    };
  }).filter(f => f.title) : [];

  // 分数与最高级别对齐：模型偶尔会凭语气拍分（只列 P3 却给 50），
  // 这里按标尺把越界分数拉回区间，保证分数和问题列表自洽。
  const SCORE_RANGE = { P0: [0, 39], P1: [40, 64], P2: [65, 84], P3: [85, 98] };
  const highest = ['P0', 'P1', 'P2', 'P3'].find(lv => findings.some(f => f.level === lv)) || '';
  const range = SCORE_RANGE[highest] || [85, 100];
  let score = Math.round(Math.max(0, Math.min(100, Number(v.score) || 0)));
  if (score < range[0]) score = range[0];
  if (score > range[1]) score = range[1];

  return {
    requirement: {
      summary: reviewStr(req.summary, 200),
      evidence: Array.isArray(req.evidence) ? req.evidence.slice(0, 4).map(e => reviewStr(e, 200)) : [],
      confidence: ['high', 'medium', 'low'].indexOf(String(req.confidence)) >= 0 ? String(req.confidence) : 'medium',
      risk: reviewStr(req.risk, 300)
    },
    verdict: {
      oneLine: reviewStr(v.oneLine, 160),
      tone: reviewStr(v.tone, 200),
      score
    },
    findings,
    strengths: Array.isArray(raw.strengths) ? raw.strengths.slice(0, 4).map(s => reviewStr(s, 200)) : [],
    nextStep: reviewStr(raw.nextStep, 300),
    aside: reviewStr(raw.aside, 240)
  };
}

// 模型常带解释和 ```，这里只认第一个完整 JSON 对象
function parseReviewJson(text) {
  const t = String(text || '').trim()
    .replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try {
    return sanitizeReview(JSON.parse(t.slice(s, e + 1)));
  } catch (_) {
    return null;
  }
}

/* ---- 通道一：CodeBuddy 自己的后台模型命令 ----
 * CodeBuddy 没有注册 Language Model provider，所以 vscode.lm 里永远没有模型；
 * 但它的 genie 扩展注册了 tencentcloud.codingcopilot.backgroundLLM.chat，
 * 走用户已登录的额度调后端 /v2/chat/completions，同步返回纯文本。 */
const CODEBUDDY_LLM_CMD = 'tencentcloud.codingcopilot.backgroundLLM.chat';

/** 每次都重新查命令表：扩展 activate 早期拿到的列表可能还没有别的扩展注册的命令，
 *  一旦把 false 缓存下来，整个会话都会误判成「没有通道」。 */
async function hasCodeBuddyLLM() {
  try {
    const cmds = await vscode.commands.getCommands(true);
    return cmds.indexOf(CODEBUDDY_LLM_CMD) >= 0;
  } catch (_) {
    return false;
  }
}

/** 候选 agent：chat() 不传 modelId 时用 agent 的 models[0]，不同环境配的默认模型不一样，
 *  有的模型根本不吐 delta.content（返回 200 但内容为空），只能逐个试。 */
const CODEBUDDY_AGENTS = ['general', 'summary', 'chat', 'default'];
const PROBE_MSG = '只回复两个字：可用';

function shortErr(e) {
  return (e && e.message ? String(e.message) : String(e)).slice(0, 90);
}

function execCodeBuddy(agentName, messages, maxTokens, temperature) {
  // 不能传 abortSignal：该命令内部在浏览器环境用 Request 构造请求，
  // 扩展宿主（Node）的 AbortSignal 跨 realm 不被识别，会直接抛
  // "Failed to construct 'Request': member signal is not of type AbortSignal"。
  // 代价是没有取消能力，只能拿返回结果丢弃。
  const n = ++llmCalls;
  const started = Date.now();
  stage('请求 #' + n + ' → ' + agentName + '（上限 ' + maxTokens + ' token）');

  let pending;
  try {
    pending = vscode.commands.executeCommand(CODEBUDDY_LLM_CMD, {
      agentName, messages, maxTokens, temperature
    });
  } catch (e) {
    stage('请求 #' + n + ' 直接抛错 · ' + shortErr(e));
    throw e;
  }

  // 结束时把「花了多久 / 有没有吐出东西」落到面板上：探针慢还是长请求慢，一眼能分开
  return Promise.resolve(pending).then(
    r => {
      const chars = typeof r === 'string' ? r.trim().length : 0;
      stage('请求 #' + n + ' ← ' + agentName + ' · ' + fmtSec(Date.now() - started)
        + ' · ' + (chars ? chars + ' 字' : '空内容'));
      return r;
    },
    e => {
      stage('请求 #' + n + ' ← ' + agentName + ' 失败 · ' + fmtSec(Date.now() - started)
        + ' · ' + shortErr(e));
      throw e;
    }
  );
}

/** 极简探针：确认这个 agent 的默认模型到底会不会吐 content */
async function probeAgent(agentName) {
  try {
    const text = await execCodeBuddy(agentName, [{ role: 'user', content: PROBE_MSG }], 64, 0);
    const t = typeof text === 'string' ? text.trim() : '';
    return t ? 'ok("' + t.slice(0, 10) + '")' : 'empty';
  } catch (e) {
    return 'err(' + shortErr(e) + ')';
  }
}

/** 上次探针成功的 agent：缓存下来，避免每次点击都白跑 4 次请求 */
let cachedAgent = '';

/** 探针结果的持久化载体（globalState）：扩展重载 / 换窗口后依然记得该用哪个 agent，
 *  否则冷启动第一次评审必定重跑一遍探针。 */
let agentStore = null;
const AGENT_KEY = 'roastBuddy.agent';

/** 从 globalState 恢复上次成功的 agent；值非法（agent 列表变了 / 手改坏）就当没存过 */
function loadCachedAgent(memento) {
  agentStore = memento || null;
  let saved = '';
  try { saved = agentStore ? agentStore.get(AGENT_KEY, '') : ''; } catch (_) { saved = ''; }
  cachedAgent = (typeof saved === 'string' && CODEBUDDY_AGENTS.indexOf(saved) >= 0) ? saved : '';
}

/** 记住成功的 agent；传空字符串表示作废（该 agent 已不可用）。
 *  写盘失败只影响下次要不要重探，不该中断本轮评审，所以吞掉异常。 */
function saveCachedAgent(agent) {
  cachedAgent = agent || '';
  if (!agentStore) return;
  Promise.resolve(agentStore.update(AGENT_KEY, cachedAgent)).catch(() => { });
}

/** 挑一个真能出字的 agent 发正式请求。
 *  稳态（有缓存）直接发正式请求，跳过探针：探针本身也是一次完整往返，
 *  这就是「每次评审都要等两趟」的来源。只有缓存失效或首次运行才逐个探。 */
async function askCodeBuddy(prompt) {
  stage('查询 CodeBuddy 后台模型命令…');
  if (!(await hasCodeBuddyLLM())) return { error: 'no-cmd' };

  const notes = [];
  const messages = [{ role: 'user', content: prompt }];
  let failedAgent = '';

  // 1) 有缓存：信任它，直接发正式请求，省掉一次探针往返
  if (cachedAgent) {
    const agent = cachedAgent;
    stage('正式请求 → ' + agent + '（沿用上次成功的 agent，跳过探针）');
    try {
      const text = await execCodeBuddy(agent, messages, 3000, readTemperature());
      if (typeof text === 'string' && text.trim()) {
        return { model: 'CodeBuddy(' + agent + ')', text: text.trim() };
      }
      notes.push(agent + ':long-empty(chars=' + prompt.length + ')');
    } catch (e) {
      notes.push(agent + ':long-err(' + shortErr(e) + ')');
    }
    // 缓存的 agent 已经不可用（换模型 / 登出 / 内容为空）：作废，别让下一轮继续白等
    failedAgent = agent;
    saveCachedAgent('');
  }

  // 2) 剩下的陌生 agent 仍然先探针：不知道它们的默认模型吐不吐内容，
  //    直接砸一发 3000 token 的正式请求，失败一次更亏。
  const candidates = CODEBUDDY_AGENTS.filter(a => a !== failedAgent);
  if (!candidates.length) return { error: 'no-channel[' + notes.join(' | ') + ']' };

  stage('候选 agent：' + candidates.join(' / ')
    + (failedAgent ? '（已排除失效的 ' + failedAgent + '）' : '（首次运行，无缓存）'));

  for (const agent of candidates) {
    const probe = await probeAgent(agent);
    // agent 不存在会报 No model available，直接跳过，不浪费一次长请求
    if (probe.indexOf('ok') !== 0) {
      notes.push(agent + ':' + probe);
      continue;
    }

    try {
      // 默认只有 500；给到 4000 容易超模型上限反而返回空，3000 够写完当前条数上限的 findings
      const text = await execCodeBuddy(agent, messages, 3000, readTemperature());
      if (typeof text === 'string' && text.trim()) {
        saveCachedAgent(agent);
        return { model: 'CodeBuddy(' + agent + ')', text: text.trim() };
      }
      notes.push(agent + ':long-empty(chars=' + prompt.length + ')');
    } catch (e) {
      notes.push(agent + ':long-err(' + shortErr(e) + ')');
    }
  }
  return { error: 'no-channel[' + notes.join(' | ') + ']' };
}

/* ---- 通道二：编辑器内置 Language Model API（装了 Copilot 这类 provider 才有模型）---- */
async function askLM(prompt, token) {
  stage('查找内置 Language Model API…');
  if (!vscode.lm || typeof vscode.lm.selectChatModels !== 'function') return { error: 'no-lm' };
  let models = [];
  try { models = await vscode.lm.selectChatModels({}); } catch (_) { return { error: 'no-lm' }; }
  if (!models || !models.length) {
    stage('内置 LM 没有可用模型，改走 CodeBuddy 后台模型');
    return { error: 'no-lm' };
  }

  const picked = models[0];
  const n = ++llmCalls;
  const started = Date.now();
  stage('请求 #' + n + ' → ' + (picked.name || 'built-in') + '（内置 LM，prompt ' + prompt.length + ' 字）');
  try {
    const res = await picked.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], {}, token);
    let text = '';
    for await (const chunk of res.text) text += chunk;
    const out = text.trim();
    stage('请求 #' + n + ' ← ' + (picked.name || 'built-in') + ' · ' + fmtSec(Date.now() - started)
      + ' · ' + (out ? out.length + ' 字' : '空内容'));
    return { model: picked.name || 'built-in', text: out };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    stage('请求 #' + n + ' ← 内置 LM 失败 · ' + fmtSec(Date.now() - started) + ' · ' + msg.slice(0, 60));
    return { error: 'request-failed: ' + msg };
  }
}

/** 通道优先级：标准 Language Model API 优先（任何注册了 provider 的宿主都能用），
 *  CodeBuddy 内置后台模型作为本机加速路径。 */
async function askModel(prompt, token) {
  const lm = await askLM(prompt, token);
  if (!lm.error) return lm;
  const cb = await askCodeBuddy(prompt);
  return cb.error ? { error: cb.error } : cb;
}

/** 给无法取消的调用套超时：宁可报错，也不让面板一直停在「正在评…」 */
function withTimeout(promise, ms, label) {
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ error: label });
    }, ms);
    promise.then(v => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    }).catch(e => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ error: e && e.message ? String(e.message) : String(e) });
    });
  });
}

/** 把内部错误翻成人话，避免把命令名、英文异常直接摊给用户 */
function friendlyError(err) {
  const e = String(err || '');
  if (e === 'no-lm' || e === 'no-cmd') {
    return '没有可用的模型：请安装并登录一个提供模型的扩展（如 GitHub Copilot Chat），或在 CodeBuddy 中登录';
  }
  if (e.indexOf('not of type AbortSignal') >= 0) return '模型通道参数异常（signal 类型不兼容）';
  if (e.indexOf('Empty response') >= 0 || e.indexOf('long-empty') >= 0) return '模型返回了空内容，可能是上下文过长或该模型不支持对话';
  if (e.indexOf('No authentication') >= 0 || e.indexOf('401') >= 0 || e.indexOf('403') >= 0) return '模型服务鉴权失败，请重新登录';
  if (e.indexOf('timed out') >= 0 || e.indexOf('timeout') >= 0) return '请求超时';
  return '模型调用失败';
}

/* ------------------------------------------------------------------ *
 * Webview
 * ------------------------------------------------------------------ */
class RoastView {
  constructor(context) {
    this.context = context;
    this.view = null;
    this.viewType = 'roastBuddy.panel';
    this._busy = false;
    // 诊断日志写扩展自己的 globalStorage，不往用户仓库里写文件
    this.logDir = (context.globalStorageUri && context.globalStorageUri.fsPath) || '';
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [media]
    };
    webviewView.webview.html = this.html(webviewView.webview, media);

    webviewView.webview.onDidReceiveMessage(async msg => {
      switch (msg.type) {
        case 'ready':
          this.postTone();
          this.postSettings();
          break;
        case 'setTone':
          await this.setTone(msg.value);
          break;
        case 'getSettings':
          this.postSettings();
          break;
        case 'setSetting':
          await this.setSetting(msg.key, msg.value);
          break;
        case 'roast':
        case 'aiReview':
          await this.runAiReview();
          break;
        case 'open': {
          const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
          if (!folder || !msg.file) return;
          const uri = vscode.Uri.joinPath(folder.uri, msg.file);
          const doc = await vscode.workspace.openTextDocument(uri);
          const ed = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
          const pos = new vscode.Position(Math.max(0, (msg.line || 1) - 1), 0);
          ed.selection = new vscode.Selection(pos, pos);
          ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
          break;
        }
      }
    });
  }

  post(msg) {
    if (this.view) this.view.webview.postMessage(msg);
  }

  rootDir() {
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    return folder ? folder.uri.fsPath : null;
  }

  /** 评审参数同步给面板（采样温度 / 问题条数上限） */
  postSettings() {
    this.post({
      type: 'settings',
      temperature: readTemperature(),
      maxFindings: readMaxFindings()
    });
  }

  /** 面板改参数：写全局配置。值越界也照写，读取时会夹回合法区间 */
  async setSetting(key, value) {
    if (key !== 'temperature' && key !== 'maxFindings') return;
    try {
      await vscode.workspace.getConfiguration('roastBuddy')
        .update(key, value, vscode.ConfigurationTarget.Global);
    } catch (e) {
      this.post({ type: 'status', text: '保存设置失败：' + (e && e.message ? e.message : String(e)) });
      return;
    }
    this.postSettings();
    this.post({
      type: 'status',
      text: key === 'temperature'
        ? '温度已设为 ' + readTemperature() + '（越高措辞越多变）'
        : '一次最多列 ' + readMaxFindings() + ' 条问题'
    });
  }

  /** 当前语气档位同步给面板：index 给滑杆，label 给文字，value 是存进配置的 key */
  postTone() {
    const v = normalizeTone(readToneSetting());
    this.post({
      type: 'tone',
      value: v,
      index: TONE_ORDER.indexOf(v) + 1,
      label: TONE_PRESETS[v].label
    });
  }

  /** 面板拖动滑杆：写全局配置，下次评审生效 */
  async setTone(value) {
    const v = normalizeTone(value);
    try {
      await vscode.workspace.getConfiguration('roastBuddy')
        .update('tone', v, vscode.ConfigurationTarget.Global);
    } catch (e) {
      this.post({ type: 'status', text: '保存语气设置失败：' + (e && e.message ? e.message : String(e)) });
      return;
    }
    const index = TONE_ORDER.indexOf(v) + 1;
    this.post({ type: 'tone', value: v, index, label: TONE_PRESETS[v].label });
    this.post({
      type: 'status',
      text: '语气已切换为「' + TONE_PRESETS[v].label + '」（第 ' + index + '/' + TONE_ORDER.length + ' 档），下次评审生效'
    });
  }

  /** AI 锐评：先还原需求，再评实现；输出 JSON 由面板渲染成固定版式 */
  async runAiReview() {
    if (this._busy) {
      this.post({ type: 'status', text: '上一轮还在评，等它结束再来' });
      return;
    }

    const root = this.rootDir();
    if (!root) { this.post({ type: 'status', text: '先打开一个项目文件夹' }); return; }

    this._busy = true;
    const startedAt = Date.now();
    llmCalls = 0;
    lastStageText = '';
    // 每条阶段都推给面板，带上累计请求次数；计时由面板自己按 at 走，免得消息延迟让秒数跳
    stageSink = text => this.post({ type: 'stage', text, calls: llmCalls });
    this.post({ type: 'busy', on: true, at: startedAt });
    try {
      this.post({ type: 'status', text: '正在收集改动上下文…' });
      let ctx;
      try {
        ctx = await collectReviewContext(root);
      } catch (e) {
        this.post({ type: 'status', text: '收集上下文失败：' + (e && e.message ? e.message : String(e)) });
        return;
      }
      if (!ctx.isRepo) {
        this.post({ type: 'status', text: '当前工作区不是 git 仓库（或没装 git），无法读取改动' });
        return;
      }
      if (!ctx.diff) {
        this.post({ type: 'status', text: '暂存区是空的。先用 git add 暂存要评审的改动（源代码管理面板点「+」也行），再来评' });
        return;
      }
      if (!ctx.srcCount) {
        this.post({ type: 'status', text: '暂存区里只有配置/生成物（.bin / .d.ts / @types），没有源码可评' });
        return;
      }

      const prompt = buildReviewPrompt(ctx);
      this.post({ type: 'status', text: '上下文 ' + prompt.length + ' 字，正在评…' });

      const tokenSource = new vscode.CancellationTokenSource();
      let r;
      try {
        r = await withTimeout(askModel(prompt, tokenSource.token), 180000, 'timed out');
      } finally {
        tokenSource.dispose();
      }

      if (r.error) {
        writeErrorLog(this.logDir, r.error, ctx);
        // 报错里带上「花了多久 / 发了几个请求 / 卡在哪一步」，不用翻日志也能判断慢的原因
        const cost = '（' + fmtSec(Date.now() - startedAt) + ' · 请求 ' + llmCalls + ' 次'
          + (lastStageText ? ' · 最后一步：' + lastStageText : '') + '）';
        const reason = friendlyError(r.error) + cost;
        if (hasRoastSkill(root)) {
          const req = writeReviewRequest(root, prompt, ctx);
          this.post({
            type: 'status',
            text: reason + '。请求已写入 ' + (vscode.workspace.asRelativePath(req) || req) +
              '，在对话里说「执行锐评」即可，结果会自动显示在这里'
          });
        } else {
          // 没有配套 skill 就不再绕外部模型：脱离代码库的模型只能做「读后感」评审，
          // 手动搬运的收益远低于误判成本，直接给安装引导更诚实。
          this.post({
            type: 'status',
            text: reason + '。请安装 GitHub Copilot Chat（或在 CodeBuddy 中登录）后重试'
          });
        }
        return;
      }

      const review = parseReviewJson(r.text);
      if (!review) {
        await vscode.env.clipboard.writeText(r.text || prompt);
        this.post({ type: 'status', text: '模型没按约定返回 JSON，原始输出已复制到剪贴板' });
        return;
      }
      this.post({ type: 'review', review, model: r.model });
      this.post({
        type: 'status',
        text: '用时 ' + fmtSec(Date.now() - startedAt) + ' · 模型请求 ' + llmCalls + ' 次'
      });
    } finally {
      this._busy = false;
      stageSink = null;
      this.post({ type: 'busy', on: false });
    }
  }

  /** skill 写回 result.json → 自动渲染（由文件监听触发） */
  handleReviewResult(fsPath) {
    try {
      const review = parseReviewJson(fs.readFileSync(fsPath, 'utf8'));
      if (!review) {
        this.post({ type: 'status', text: ROAST_RESULT + ' 解析失败，检查 JSON 格式' });
        return;
      }
      this.post({ type: 'review', review, model: 'skill' });
      this.post({ type: 'status', text: '' });
    } catch (e) {
      this.post({ type: 'status', text: '读取结果失败：' + (e && e.message ? e.message : String(e)) });
    }
  }

  /** 粘贴模型输出（剪贴板）→ 解析成固定版式 */
  async pasteReview() {
    let text = '';
    try { text = await vscode.env.clipboard.readText(); } catch (_) { /* 无剪贴板 */ }

    const review = parseReviewJson(text);
    if (!review) {
      this.post({ type: 'status', text: '剪贴板里没解析出符合格式的 JSON 结果' });
      return;
    }
    this.post({ type: 'review', review, model: '粘贴' });
    this.post({ type: 'status', text: '' });
  }

  html(webview, media) {
    const nonce = Array.from({ length: 24 }, () =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]).join('');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'));
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<link rel="stylesheet" href="${css}">
<title>锐评</title>
</head>
<body>
<div id="app">
  <div class="toolbar">
    <button id="btn-ai" class="primary" title="先还原这次的需求，再对照实现挑问题">AI 锐评</button>
    <button id="btn-settings" class="icon-btn" title="评审参数设置" aria-expanded="false">⚙</button>
  </div>
  <div class="tonebar">
    <span class="tonebar-label">语气</span>
    <input id="tone-range" class="range" type="range" min="1" max="5" step="1" value="3"
      title="左轻右重：只影响措辞，不影响问题分级和分数">
    <span class="tone-current">
      <span id="tone-face" class="tone-face" aria-hidden="true">😐</span>
      <span id="tone-name" class="tone-name">耿直同事</span>
    </span>
  </div>
  <div id="settings" class="settings hide">
    <div class="set-row">
      <span class="set-label">措辞变化</span>
      <input id="set-temp" class="range" type="range" min="0" max="1" step="0.05" value="0.3"
        title="模型的随机程度：往左同一份改动每次结论更像，往右措辞更放飞">
      <span id="set-temp-val" class="set-val">0.30</span>
    </div>
    <div class="set-row">
      <span class="set-label">问题条数</span>
      <input id="set-max" class="range" type="range" min="1" max="10" step="1" value="6"
        title="一次最多列出几条问题；没问题的改动会自动输出 0 条">
      <span id="set-max-val" class="set-val">6</span>
    </div>
    <div class="set-hint">
      措辞变化：往左更稳定（每次结论接近），往右更放飞（措辞更多变）。<br>
      问题条数：一次最多列几条；简单改动会自动输出 0 条。<br>
      两项都只影响评审过程，不改问题分级与分数。
    </div>
  </div>
  <div id="status" class="status"></div>
  <div id="loader" class="loader hide">
    <canvas id="snack" width="280" height="48"></canvas>
    <div id="loader-text" class="loader-text"></div>
    <div class="loader-meta">
      <span id="loader-time" class="loader-time">0.0s</span>
      <span id="loader-stage" class="loader-stage"></span>
    </div>
  </div>
  <div id="content" class="content">
    <div class="empty">
      <div class="empty-title">还没开始骂</div>
      <div class="empty-sub">
        先把要评审的改动 <code>git add</code> 进暂存区，再点上面那个按钮（或 <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>R</kbd>）。<br>
        只审暂存区——没 add 的改动不会被评。
      </div>
    </div>
  </div>
</div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

/* ------------------------------------------------------------------ *
 * 激活
 * ------------------------------------------------------------------ */
function activate(context) {
  // 冷启动先恢复上次探针成功的 agent：命中就直接发正式请求，省掉整轮探针
  loadCachedAgent(context.globalState);
  const view = new RoastView(context);

  // ---- skill 结果监听：request.json 被 skill 处理后写回 result.json，落地即渲染 ----
  const watcher = vscode.workspace.createFileSystemWatcher('**/.codebuddy/roast/result.json');
  watcher.onDidCreate(uri => view.handleReviewResult(uri.fsPath));
  watcher.onDidChange(uri => view.handleReviewResult(uri.fsPath));
  context.subscriptions.push(watcher);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('roastBuddy.panel', view, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('roastBuddy.roast', () => view.runAiReview()),
    // 面板上不再放按钮：只在模型输出格式跑偏、需要手动补一次时从命令面板调用
    vscode.commands.registerCommand('roastBuddy.importReview', () => view.pasteReview()),
    // 可审计入口：把「将要发送给模型的完整文本」原样打开，方便核对隐私与采集范围
    vscode.commands.registerCommand('roastBuddy.showPrompt', async () => {
      const root = view.rootDir();
      if (!root) {
        vscode.window.showInformationMessage('先打开一个项目文件夹');
        return;
      }
      const ctx = await collectReviewContext(root);
      const doc = await vscode.workspace.openTextDocument({
        content: buildReviewPrompt(ctx),
        language: 'markdown'
      });
      await vscode.window.showTextDocument(doc, { preview: false });
    }),
    // 设置界面里改了参数，面板控件同步
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('roastBuddy.tone')) view.postTone();
      if (e.affectsConfiguration('roastBuddy.temperature') || e.affectsConfiguration('roastBuddy.maxFindings')) {
        view.postSettings();
      }
    })
  );
}

function deactivate() { }

module.exports = {
  activate,
  deactivate,
  __test: {
    parseDiff, askModel, askCodeBuddy, askLM, hasCodeBuddyLLM, CODEBUDDY_LLM_CMD,
    collectReviewContext, buildReviewPrompt, sanitizeReview, parseReviewJson, REVIEW_SCHEMA,
    writeReviewRequest, roastPath, ROAST_DIR, ROAST_REQUEST, ROAST_RESULT
  }
};
