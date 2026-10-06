#!/usr/bin/env bash
#
# verify-maimemo.sh —— 动工前的只读验证脚本
#
# 当前需求只加入单词：脚本不创建例句、不调用 phrases，也不写入墨墨账号。
#
#   auth      检查 token 与基础查词接口
#   coverage  统计样本词在墨墨词库中的收录率
#   study     检查学习数据接口是否可用
#   all       依次执行上述三项
#
# 依赖：curl、jq（>= 1.6）

set -euo pipefail

BASE="${MAIMEMO_BASE:-https://open.maimemo.com/open}"
SLEEP_SEC="${MAIMEMO_SLEEP:-1.6}"
COVERAGE_PASS="${COVERAGE_PASS:-90}"
COVERAGE_WARN="${COVERAGE_WARN:-70}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${MAIMEMO_OUT:-$ROOT/out}"
RAW_DIR="$OUT_DIR/raw"
RESULTS_FILE="$OUT_DIR/results.tsv"
WORDS_FILE="$ROOT/scripts/wordlists/academic-sample.txt"

PROBE_WORD="apple"
REQ_N=0
API_STATUS=""
API_BODY=""
CURL_CONF=""

c_reset=""; c_red=""; c_grn=""; c_ylw=""; c_dim=""; c_bold=""
if [ -t 1 ]; then
  c_reset=$'\033[0m'; c_red=$'\033[31m'; c_grn=$'\033[32m'
  c_ylw=$'\033[33m'; c_dim=$'\033[2m'; c_bold=$'\033[1m'
fi

step() { printf '\n%s== %s ==%s\n' "$c_bold" "$*" "$c_reset"; }
ok()   { printf '  %sPASS%s  %s\n' "$c_grn" "$c_reset" "$*"; }
bad()  { printf '  %sFAIL%s  %s\n' "$c_red" "$c_reset" "$*"; }
warn() { printf '  %sWARN%s  %s\n' "$c_ylw" "$c_reset" "$*"; }
note() { printf '  %s..    %s%s\n' "$c_dim" "$*" "$c_reset"; }
die()  { printf '%serror:%s %s\n' "$c_red" "$c_reset" "$*" >&2; exit 1; }
record() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$RESULTS_FILE"; }

usage() {
  cat <<'USAGE'
用法: scripts/verify-maimemo.sh <命令> [选项]

命令
  auth      只验 token 是否有效（1 次只读请求）
  coverage  批量查词，计算样本词库收录率（只读）
  study     检查学习数据接口（只读）
  all       依次执行 auth、coverage、study（只读）

选项
  --word <单词>        study 使用的探针词，默认 apple
  --words-file <路径>  coverage 使用的词表
  --sleep <秒>         每次请求前的间隔，默认 1.6
  -h, --help           显示本帮助

Token
  从 MAIMEMO_TOKEN 环境变量读取，或 repo 根目录的 .env 里的 MAIMEMO_TOKEN=xxx。
  必须是 App 内「我的 → 更多设置 → 实验功能 → 开放 API」的长期 token。
  本脚本不会打印 token，也不会向墨墨写入数据。

产物
  out/raw/*.json       每次请求的原始响应
  out/coverage.csv     逐词收录结果
  out/summary.md       结论汇总
USAGE
}

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "缺少依赖：$1"; }

load_token() {
  local t="${MAIMEMO_TOKEN:-}"
  if [ -z "$t" ] && [ -f "$ROOT/.env" ]; then
    t="$(sed -n 's/^[[:space:]]*MAIMEMO_TOKEN[[:space:]]*=[[:space:]]*//p' "$ROOT/.env" | tail -1)"
    t="${t%\"}"; t="${t#\"}"; t="${t%\'}"; t="${t#\'}"
  fi
  [ -n "$t" ] || die "没拿到 token。设 MAIMEMO_TOKEN 环境变量，或在 $ROOT/.env 里写 MAIMEMO_TOKEN=xxx"

  CURL_CONF="$(mktemp "${TMPDIR:-/tmp}/maimemo-curlrc.XXXXXX")"
  chmod 600 "$CURL_CONF"
  {
    printf 'header = "Authorization: Bearer %s"\n' "$t"
    printf 'header = "Accept: application/json"\n'
    printf 'header = "Content-Type: application/json"\n'
    printf 'silent\nshow-error\n'
  } > "$CURL_CONF"
}

cleanup_tmp() { [ -z "$CURL_CONF" ] || rm -f "$CURL_CONF"; }
trap cleanup_tmp EXIT

# api METHOD PATH LABEL [BODY]
api() {
  local method="$1" path="$2" label="$3" body="${4:-}"
  label="$(printf '%s' "$label" | tr -c 'A-Za-z0-9._-' '_')"
  REQ_N=$((REQ_N + 1))
  API_BODY="$RAW_DIR/$(printf '%03d' "$REQ_N")-$label.json"

  local attempt=1
  while :; do
    sleep "$SLEEP_SEC"
    if [ -n "$body" ]; then
      API_STATUS="$(curl -K "$CURL_CONF" -sS -X "$method" "$BASE$path" \
        --data-binary "$body" -o "$API_BODY" -w '%{http_code}')" || API_STATUS="000"
    else
      API_STATUS="$(curl -K "$CURL_CONF" -sS -X "$method" "$BASE$path" \
        -o "$API_BODY" -w '%{http_code}')" || API_STATUS="000"
    fi
    if [ "$API_STATUS" = "429" ] && [ "$attempt" -lt 3 ]; then
      warn "429 限流，等 15s 重试（$attempt/3）"
      sleep 15
      attempt=$((attempt + 1))
      continue
    fi
    break
  done
}

api_ok() {
  case "$API_STATUS" in 200|201) ;; *) return 1;; esac
  [ "$(jq -r '.success // false' "$API_BODY" 2>/dev/null)" = "true" ]
}

api_jq() { jq -r "$1 // empty" "$API_BODY" 2>/dev/null || true; }

api_dump() {
  note "HTTP $API_STATUS  $(basename "$API_BODY")"
  local errs
  errs="$(jq -c '.errors // []' "$API_BODY" 2>/dev/null || echo '?')"
  [ "$errs" = "[]" ] || note "errors: $errs"
  if [ "$errs" = "?" ]; then
    note "非 JSON 响应，前 300 字节："
    head -c 300 "$API_BODY" | sed 's/^/        /'
    echo
  fi
}

cmd_auth() {
  step "token 与基础连通性"
  api GET "/api/v1/vocabulary?spelling=$PROBE_WORD" "auth-vocabulary"
  api_dump
  if api_ok; then
    local id
    id="$(api_jq '.data.voc.id')"
    if [ -n "$id" ]; then
      ok "token 有效，查词接口正常（$PROBE_WORD -> ${id:0:12}…）"
      record PASS "token" "查词接口 200，success=true"
      return 0
    fi
    warn "返回 success=true 但没解析出 .data.voc.id，响应结构可能变了"
    record WARN "token" "success=true 但结构不符，见 $(basename "$API_BODY")"
    return 0
  fi
  case "$API_STATUS" in
    401|403) bad "认证失败。确认使用 App 内开放 API 的长期 token" ;;
    000)     bad "请求没发出去，检查网络或代理" ;;
    *)       bad "查词接口没通（HTTP $API_STATUS）" ;;
  esac
  record FAIL "token" "HTTP $API_STATUS"
  return 1
}

parse_wordlist() {
  local src="$1" dst="$2" group="未分组" line word
  : > "$dst"
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      '#'*) group="$(printf '%s' "${line#\#}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"; continue ;;
      ''|'//'*) continue ;;
    esac
    word="$(printf '%s' "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [ -z "$word" ] || printf '%s\t%s\n' "$group" "$word" >> "$dst"
  done < "$src"
}

query_batch() {
  local body
  body="$(jq -nc --args '{spellings: $ARGS.positional}' "$@")"
  api POST "/api/v1/vocabulary/query" "voc-query" "$body"
  if api_ok; then
    jq -r '.data.voc[]? | [(.spelling | ascii_downcase), .id] | @tsv' "$API_BODY" >> "$OUT_DIR/.found.tsv"
    note "查了 $# 个，命中 $(jq -r '(.data.voc // []) | length' "$API_BODY")"
  else
    api_dump
    die "批量查词失败，收录率算不出来"
  fi
}

cmd_coverage() {
  step "词库收录率"
  [ -f "$WORDS_FILE" ] || die "词表不存在：$WORDS_FILE"
  local words_tsv="$OUT_DIR/.words.tsv"
  parse_wordlist "$WORDS_FILE" "$words_tsv"
  local total
  total="$(wc -l < "$words_tsv" | tr -d ' ')"
  [ "$total" -gt 0 ] || die "词表里一个词都没解析出来：$WORDS_FILE"
  note "词表共 $total 个词"

  printf '__sentinel__\t__sentinel__\n' > "$OUT_DIR/.found.tsv"
  local w; local -a batch; batch=()
  while IFS= read -r w; do
    batch[${#batch[@]}]="$w"
    if [ "${#batch[@]}" -ge 100 ]; then query_batch "${batch[@]}"; batch=(); fi
  done < <(awk -F'\t' '{print $2}' "$words_tsv" | awk '!seen[tolower($0)]++')
  [ "${#batch[@]}" -eq 0 ] || query_batch "${batch[@]}"

  {
    echo "word,group,found,voc_id"
    awk -F'\t' 'NR==FNR { id[$1] = $2; next }
      { k = tolower($2); printf "%s,%s,%d,%s\n", $2, $1, (k in id), (k in id ? id[k] : "") }' \
      "$OUT_DIR/.found.tsv" "$words_tsv"
  } > "$OUT_DIR/coverage.csv"

  printf '\n  %-20s %6s %6s %8s\n' "分组" "命中" "总数" "收录率"
  awk -F',' 'NR>1 { n[$2]++; if ($3=="1") h[$2]++ }
    END { for (g in n) printf "  %-20s %6d %6d %7.1f%%\n", g, h[g]+0, n[g], (h[g]+0)*100/n[g] }' \
    "$OUT_DIR/coverage.csv" | sort

  local hit pct ctrl_n ctrl_h verdict
  hit="$(awk -F',' 'NR>1 && $3=="1"' "$OUT_DIR/coverage.csv" | wc -l | tr -d ' ')"
  pct="$(awk -v h="$hit" -v t="$total" 'BEGIN { printf "%.1f", h*100/t }')"
  ctrl_n="$(awk -F',' 'NR>1 && $2=="control-common"' "$OUT_DIR/coverage.csv" | wc -l | tr -d ' ')"
  ctrl_h="$(awk -F',' 'NR>1 && $2=="control-common" && $3=="1"' "$OUT_DIR/coverage.csv" | wc -l | tr -d ' ')"
  verdict="$(awk -v p="$pct" -v a="$COVERAGE_PASS" -v b="$COVERAGE_WARN" \
    'BEGIN { print (p >= a) ? "PASS" : ((p >= b) ? "WARN" : "FAIL") }')"
  case "$verdict" in
    PASS) ok "总收录率 ${pct}%（${hit}/${total}），高于自定阈值 ${COVERAGE_PASS}%" ;;
    WARN) warn "总收录率 ${pct}%（${hit}/${total}），在 ${COVERAGE_WARN}%–${COVERAGE_PASS}% 之间" ;;
    FAIL) bad "总收录率 ${pct}%（${hit}/${total}），低于自定阈值 ${COVERAGE_WARN}%" ;;
  esac
  [ "$ctrl_n" -eq 0 ] || [ "$ctrl_h" -eq "$ctrl_n" ] || warn "对照组只命中 $ctrl_h/$ctrl_n，先检查查询方式"
  record "$verdict" "词库收录率" "${pct}%（${hit}/${total}），对照组 ${ctrl_h}/${ctrl_n}"
  rm -f "$words_tsv" "$OUT_DIR/.found.tsv"
}

cmd_study() {
  step "学习数据接口"
  api POST "/api/v1/study/get_study_progress" "study-progress" '{}'
  api_dump
  if api_ok; then
    ok "get_study_progress 可用"
    record PASS "学习数据接口" "get_study_progress 可用"
  else
    warn "学习数据接口没通（HTTP $API_STATUS）。公测接口可能要求 App 开启自动同步"
    record WARN "学习数据接口" "HTTP $API_STATUS，见 $(basename "$API_BODY")"
  fi
}

write_summary() {
  [ -s "$RESULTS_FILE" ] || return 0
  step "结论"
  local st name detail
  while IFS=$'\t' read -r st name detail; do
    case "$st" in
      PASS) ok "$name —— $detail" ;;
      FAIL) bad "$name —— $detail" ;;
      WARN) warn "$name —— $detail" ;;
    esac
  done < "$RESULTS_FILE"
  {
    echo "# 墨墨单词加入前置验证结果"
    echo
    echo "跑于 $(date '+%Y-%m-%d %H:%M:%S')，原始响应见 out/raw/。"
    echo
    echo "| 结果 | 检查项 | 细节 |"
    echo "|---|---|---|"
    awk -F'\t' '{printf "| %s | %s | %s |\n", $1, $2, $3}' "$RESULTS_FILE"
  } > "$OUT_DIR/summary.md"
  note "汇总写到 out/summary.md"
}

main() {
  local cmd="${1:-}"
  [ -n "$cmd" ] || { usage; exit 1; }
  shift || true
  case "$cmd" in -h|--help|help) usage; exit 0;; esac
  while [ $# -gt 0 ]; do
    case "$1" in
      --word)       PROBE_WORD="${2:?--word 后面要跟单词}"; shift 2 ;;
      --words-file) WORDS_FILE="${2:?--words-file 后面要跟路径}"; shift 2 ;;
      --sleep)      SLEEP_SEC="${2:?--sleep 后面要跟秒数}"; shift 2 ;;
      -h|--help)    usage; exit 0 ;;
      *)            die "未知参数：$1（看 --help）" ;;
    esac
  done
  need_cmd curl
  need_cmd jq
  mkdir -p "$RAW_DIR"
  : > "$RESULTS_FILE"
  load_token
  local rc=0
  case "$cmd" in
    auth)     cmd_auth || rc=$? ;;
    coverage) cmd_coverage || rc=$? ;;
    study)    cmd_study || rc=$? ;;
    all)      cmd_auth && cmd_coverage && cmd_study || rc=$? ;;
    *)        die "未知命令：$cmd（看 --help）" ;;
  esac
  write_summary
  return "$rc"
}

main "$@"
