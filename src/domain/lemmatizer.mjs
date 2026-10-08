// 英文词形还原。纯本地、无网络：弹窗要在划词那一刻立刻给出原形，
// 而且结果是可编辑的，猜错了用户当场能改。
//
// 只做屈折变化（复数、-ed、-ing、不规则形），这是读论文时绝大多数情况。
// 派生变化（orthogonality → orthogonal）只放进候选，不作为首选，
// 因为没有词典仲裁时 quality → qual 这类错误比不还原更糟。

function parsePairs(text) {
  const map = new Map();
  for (const line of text.trim().split("\n")) {
    const [from, to] = line.trim().split(/\s+/);
    if (from && to) map.set(from, to);
  }
  return map;
}

// 学术文本里真正高频的不规则复数，拉丁/希腊词尾占大头。
const IRREGULAR_NOUNS = parsePairs(`
analyses analysis
hypotheses hypothesis
theses thesis
syntheses synthesis
diagnoses diagnosis
parentheses parenthesis
bases basis
crises crisis
axes axis
matrices matrix
indices index
vertices vertex
appendices appendix
criteria criterion
phenomena phenomenon
stimuli stimulus
nuclei nucleus
radii radius
fungi fungus
foci focus
loci locus
bacteria bacterium
media medium
curricula curriculum
spectra spectrum
strata stratum
errata erratum
formulae formula
larvae larva
vertebrae vertebra
mice mouse
men man
women woman
children child
geese goose
feet foot
teeth tooth
people person
lives life
leaves leaf
knives knife
wolves wolf
halves half
selves self
`);

const IRREGULAR_VERBS = parsePairs(`
is be
are be
am be
was be
were be
been be
being be
has have
had have
having have
does do
did do
done do
went go
gone go
made make
said say
took take
taken take
got get
gotten get
found find
gave give
given give
shown show
showed show
knew know
known know
grew grow
grown grow
drew draw
drawn draw
saw see
seen see
chose choose
chosen choose
wrote write
written write
drove drive
driven drive
held hold
led lead
met meet
built build
sent send
spent spend
left leave
felt feel
kept keep
slept sleep
meant mean
dealt deal
lost lose
sold sell
told tell
thought think
brought bring
bought buy
caught catch
taught teach
fought fight
sought seek
became become
begun begin
began begin
broke break
broken break
came come
fell fall
fallen fall
flew fly
flown fly
forgot forget
forgotten forget
froze freeze
frozen freeze
hid hide
hidden hide
rose rise
risen rise
stood stand
stolen steal
threw throw
thrown throw
understood understand
won win
arose arise
arisen arise
paid pay
laid lay
ran run
`);

// 本身就以双写辅音结尾的词，去重复辅音规则必须绕开它们，
// 否则 calling 会被还原成 cal、installed 会被还原成 instal。
const DOUBLED_BASES = new Set(`
call fall tell sell fill kill pull roll install spell smell swell fulfill instill
bill drill stall poll toll dwell yell pass miss press cross dress stress discuss
address express process access assess guess add ebb buzz egg off err purr stuff
staff sniff scoff bluff recall befall enroll
`.trim().split(/\s+/));

// 去掉 -ed/-ing 后以 "it" 结尾的词干，默认不补 e（visit、limit、edit、exhibit），
// 这几个是反例，必须补。
const SILENT_E_AFTER_IT = new Set("cit invit unit excit ignit incit recit writ".split(" "));

// 元音二合字母是一个音，后面的辅音不吃 e：contain、remain、appear、reveal。
// "ua""ia""io" 这种分属两个音节，照常补 e：attenuate、deviate。
const VOWEL_DIGRAPHS = new Set("ai ay ea ee ei ey ie oa oo ou ow oi oy au aw".split(" "));

// -er 结尾默认不补 e：consider、order、differ、transfer。下面几个反过来。
const SILENT_E_AFTER_ER = new Set("adher interfer".split(" "));

const VOWELS = new Set(["a", "e", "i", "o", "u"]);
const LEMMA_PATTERN = /^[\p{L}][\p{L}'-]*$/u;

function isDoubledEnding(stem) {
  if (stem.length < 4) return false;
  const last = stem.at(-1);
  return last === stem.at(-2) && "bdgklmnprtz".includes(last);
}

// -ing / -ed 去掉词尾后，判断要不要把省略的 e 补回来。
// converg → converge，denot → denote，attenuat → attenuate；
// 而 confound、present、visit 保持原样。
function restoreSilentE(stem) {
  if (stem.length < 3) return false;
  const last = stem.at(-1);
  // -ce/-ge/-se/-ve/-ze 结尾的动词，e 一定是被吃掉的。
  if ("cgsvz".includes(last)) return true;
  if (VOWELS.has(last)) return false;
  // 辅音连缀说明词干本身完整：confound、present、connect。
  if (!VOWELS.has(stem.at(-2))) return false;
  // w/x/y 结尾不补 e：allow、employ、relax。
  if ("wxy".includes(last)) return false;
  if (VOWEL_DIGRAPHS.has(stem.slice(-3, -1))) return false;
  // 元音 + 单辅音是长音节，通常要补 e；"it" 和 "er" 结尾反过来。
  if (stem.endsWith("it")) return SILENT_E_AFTER_IT.has(stem);
  if (stem.endsWith("er")) return SILENT_E_AFTER_ER.has(stem);
  return true;
}

function stemCandidates(stem) {
  const results = [];
  if (restoreSilentE(stem)) results.push(stem + "e", stem);
  else results.push(stem, stem + "e");
  // controll → control 要去重复，但 call、install 本身就以双写结尾。
  if (isDoubledEnding(stem) && !DOUBLED_BASES.has(stem)) {
    results.unshift(stem.slice(0, -1));
  }
  return results;
}

function inflectionalCandidates(word) {
  const irregular = IRREGULAR_NOUNS.get(word) ?? IRREGULAR_VERBS.get(word);
  if (irregular) return [irregular];

  const results = [];
  if (word.endsWith("ies") && word.length > 4) results.push(word.slice(0, -3) + "y");
  if (word.endsWith("ves") && word.length > 4) results.push(word.slice(0, -3) + "f", word.slice(0, -3) + "fe");
  if (word.endsWith("ied") && word.length > 4) results.push(word.slice(0, -3) + "y");

  if (word.endsWith("ing") && word.length > 5) results.push(...stemCandidates(word.slice(0, -3)));
  else if (word.endsWith("ed") && word.length > 4) results.push(...stemCandidates(word.slice(0, -2)));

  if (/(ses|xes|zes|ches|shes)$/.test(word) && word.length > 4) results.push(word.slice(0, -2));
  // bias / atlas 这类元音加 s 的单数词会被误当成复数，拼写上跟 ideas / areas
  // 没有区别。原词始终留在候选里，等词库仲裁时能纠回来。
  if (word.endsWith("es") && word.length > 3) results.push(word.slice(0, -1), word.slice(0, -2));
  else if (word.endsWith("s") && !/(ss|us|is)$/.test(word) && word.length > 3) results.push(word.slice(0, -1));

  return results;
}

// 派生后缀只进候选，不当首选：没有词典仲裁时猜错的代价太大。
function derivationalCandidates(word) {
  const results = [];
  if (word.endsWith("ality") && word.length > 7) results.push(word.slice(0, -3));
  if (word.endsWith("ivity") && word.length > 7) results.push(word.slice(0, -3) + "e");
  if (word.endsWith("ization") && word.length > 9) results.push(word.slice(0, -7) + "ize");
  if (word.endsWith("isation") && word.length > 9) results.push(word.slice(0, -7) + "ise");
  if (word.endsWith("ness") && word.length > 6) results.push(word.slice(0, -4));
  return results;
}

/**
 * 返回按可信度排序的原形候选，第一个是首选。原词本身总在列表里，
 * 因为它可能已经是原形（analysis、process、focus 都以 s 结尾）。
 */
export function lemmaCandidates(surface) {
  if (typeof surface !== "string") throw new TypeError("surface must be a string");
  const word = surface.normalize("NFKC").replaceAll("’", "'").trim().toLocaleLowerCase("en-US");
  if (!word) return [];

  const ordered = [...inflectionalCandidates(word), word, ...derivationalCandidates(word)];
  return [...new Set(ordered)].filter((item) => item.length >= 2 && LEMMA_PATTERN.test(item));
}

export class RuleLemmatizer {
  async lemmatize(surface) {
    const [best] = lemmaCandidates(surface);
    return best ?? surface;
  }

  async candidates(surface) {
    return lemmaCandidates(surface);
  }
}

// 测试与不需要还原的场景使用。
export class IdentityLemmatizer {
  async lemmatize(surface) {
    return surface;
  }
}
