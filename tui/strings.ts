/**
 * Every word the terminal draws, and the gateway's words for it, in each language the `language`
 * setting takes. The terminal starts in the language of its environment (LC_ALL, LC_MESSAGES,
 * LANG) and switches to the gateway's once connected, so `dsh` speaks as the bot does.
 */
import type { Language } from '../i18n.js'

const en = {
  connecting: 'connecting…',
  disconnected: (detail: string | undefined) => `disconnected · ${detail ?? 'reconnecting'}`,
  reconnectingIn: (ms: number) => `reconnecting in ${ms}ms`,
  refused: (message: string) => `refused: ${message}`,
  unreadable: (error: string) => `unreadable frame from the gateway: ${error}`,
  noGatewayNamed: (name: string, found: string[]) => `no running gateway is named '${name}' (found: ${found.join(', ') || 'none'})`,
  noGateway: (dir: string) => `no running gateway found (${dir}). Start the gateway, with 'local' in deepbot's platform`,
  severalGateways: (found: string[]) => `several gateways are running: ${found.join(', ')} — pick one with --name`,
  notConnected: 'not connected to the gateway',
  notSent: 'not sent: not connected to the gateway',
  answerNotSent: 'answer not sent: not connected to the gateway — the question opens again on reconnect',
  noHarness: (bin: string) => `dsh: no DeepSeek Harness CLI at ${bin} (give its path in DSH_BIN)\n`,
  selfHarness: "dsh: DSH_BIN points at this command itself — give the harness CLI's path\n",
  needsTty: 'dsh: needs a terminal (a TTY)\n',
  unknownOption: (flag: string) => `unknown option: ${flag}`,
  needsValue: (flag: string) => `${flag} needs a value`,
  usage: `dsh — talk to deepseek-bot in the terminal

  dsh [--name <gateway>] [--socket <path>] [--tenant <name>] [--resume <conversation>]
  dsh <anything else>   handed to the DeepSeek Harness CLI (DSH_BIN, by default the dsh in the app)

  --name     the gateway to connect to (tuiName in the deepbot config, by default default)
  --socket   the gateway's socket path, given directly
  --tenant   talk in a tenant's workspace (needs tenantIsolation on)
  --resume   continue an earlier conversation (the id printed on exit)
`,
  resumeHint: (conversation: string) => `to continue this conversation: dsh --resume ${conversation}\n`,
  tenantTalking: (tenant: string) => `talking in the workspace of tenant ${tenant}`,
  commands: {
    new: { hint: 'a new conversation (same workspace)' },
    sessions: { hint: 'the terminal conversations, with their tenant' },
    resume: { usage: '<n|id>', hint: 'continue a conversation from the list' },
    tenant: { usage: '[name]', hint: "a new conversation in that tenant's workspace (no name: the configured default, else home)" },
    interview: { usage: '<topic>', hint: 'deep interview: one question at a time until it is clear, then a spec' },
    usage: { hint: 'tokens used so far' },
    clear: { hint: 'clear the screen (the conversation stays)' },
    help: { hint: 'this help' },
    quit: { hint: 'quit (ctrl+c twice, or ctrl+d)' },
    exit: { hint: 'the same as /quit' },
  },
  helpKeys: [
    '↵ send · alt+↵ newline · esc interrupt · wheel/PgUp/PgDn scroll · drag to copy',
    '/ commands · @ files (tab inserts) · ctrl+r search what you typed · ctrl+o expand/fold thinking and tool output',
  ],
  ago: (seconds: number) => seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.round(seconds / 60)}m ago`
    : seconds < 86400 ? `${Math.round(seconds / 3600)}h ago` : `${Math.round(seconds / 86400)}d ago`,
  noSessions: 'no terminal conversation in this workspace yet',
  untitled: '(untitled)',
  turns: (n: number) => `${n} turn${n === 1 ? '' : 's'}`,
  resumeHow: '/resume <n> to continue one',
  newConversation: 'new conversation',
  defaultWorkspace: 'default workspace',
  resumeUsage: '/resume <n|id> — n is a number from /sessions',
  interviewUsage: '/interview <topic> — what the interview is about',
  couldNotSwitch: (message: string) => `could not switch: ${message} — staying in this conversation`,
  planReviewRequested: 'plan review requested',
  planReview: 'plan review',
  question: 'question',
  questionClosed: 'question closed',
  typeOwn: 'type your own…',
  skipped: '(skipped)',
  earlier: (n: number) => `earlier in this conversation · last ${n} messages`,
  continuedHere: '── continued from here ──',
  jobRemoved: 'removed · cleaned up when the turn that started it ended',
  jobEnded: (status: string) => `ended · ${status}`,
  loading: 'loading',
  pasteCut: (n: string) => `paste too long: kept the first ${n} characters`,
  askedToStop: (label: string) => `asked ${label} to stop`,
  askedToEnd: (id: string) => `asked ${id} to end`,
  oneShot: 'this subagent is one-shot and takes no messages',
  sentTo: (label: string) => `→ sent to ${label}`,
  shellNoInput: 'a shell takes no input · esc back to main',
  ctrlCAgain: 'press Ctrl+C again to quit',
  copied: (n: number, osc52: boolean) => `copied · ${n} chars${osc52 ? ' (OSC 52)' : ''}`,
  choiceHint: '←→ choose · ↵ confirm · click',
  newLines: (n: number) => ` ↓ ${n} new `,
  hints: {
    search: (query: string, found: boolean) => `(history search) ${query}${found ? '' : ' · no match'} · ctrl+r older · ↵ pick · esc cancel`,
    completion: '↑↓ pick · tab insert · ↵ run · esc close',
    typing: 'type, then ↵ · esc back to the options',
    question: (multi: boolean) => `↑↓ move${multi ? ' · space select' : ''} · ↵ confirm · esc skip · type to answer in your own words`,
    panel: '↑↓ move · ↵ open · esc back to the input',
    agent: (label: string) => `↵ send to ${label} · ctrl+x stop · esc back to main`,
    job: 'ctrl+x end · wheel scroll · esc back to main',
    running: 'esc interrupt · wheel scroll · drag to copy',
    idle: (panel: boolean) => `↵ send · alt+↵ newline · drag to copy${panel ? ' · tab panel' : ''} · /help · ctrl+c quit`,
  },
  interview: 'deep interview',
  interviewPreparing: 'preparing the first question',
  interviewDone: 'done',
  interviewAmbiguity: (ambiguity: number, target: number) => `ambiguity ${ambiguity}% → target ${target}% or less`,
  interviewEstimate: "clarity is the model's own estimate, not a measurement",
  /** The dimensions the interview's example block names; the model tends to keep them. */
  interviewScores: ['goal', 'constraints', 'success criteria', 'context'],
  moreLines: (n: number) => `${n} more lines`,
  thinking: 'thinking…',
  working: 'working…',
  runningTool: (name: string) => `running ${name}…`,
  queued: 'queued',
  queuedCount: (n: number) => `${n} queued`,
  thought: (n: number, expanded: boolean) => `thought · ${n} chars${expanded ? '' : ' · ctrl+o expand'}`,
  diffUncompared: '… too large to compare line by line',
  diffWithheld: (n: number) => `… large change: only the lines that are certain, ${n} left out (truncated)`,
  diffHead: '… large change: only the beginning (truncated)',
  diffNoneCertain: '… large change: no line is certain once cut (truncated)',
  diffNoDifference: '… large change: no difference in the part shown (truncated)',
  noOutput: '(no output)',
  /** The gateway's side: what it tells a terminal. */
  gateway: {
    charsLeftOut: (n: number) => `(${n} chars left out)`,
    noSubagentMessaging: 'this deployment cannot message a subagent',
    parentNotRunning: 'not sent: the parent conversation has no turn running — only possible while one runs',
    notResumable: 'this subagent takes no messages (it is one-shot, or not a direct child)',
    notSent: (message: string) => `not sent: ${message}`,
    frameTooLarge: (type: string) => `${type} frame too large to send`,
    tooManyTerminals: 'too many terminals attached',
    tenantOff: 'tenant isolation is not enabled in this deployment',
    badTenant: 'a tenant name is one directory name: not empty, not . or .., no /',
    tenantMismatch: (tenant: string | null) => `this conversation belongs to ${tenant === null ? 'the home workspace' : `tenant ${tenant}`}`,
    questionClosed: 'that question is already closed',
    notInPanel: "not in this conversation's panel",
    notSubagent: 'not a subagent of this conversation',
    needsText: 'a message needs text',
    notJob: 'not a job of this conversation',
    notButton: 'not a button of this conversation',
  },
}

export type Strings = typeof en

const ko: Strings = {
  connecting: '연결 중…',
  disconnected: (detail) => `연결 끊김 · ${detail ?? '재연결 중'}`,
  reconnectingIn: (ms) => `${ms}ms 후 재연결`,
  refused: (message) => `거부됨: ${message}`,
  unreadable: (error) => `gateway 응답을 읽지 못함: ${error}`,
  noGatewayNamed: (name, found) => `'${name}' 이름으로 실행 중인 gateway가 없음 (찾은 것: ${found.join(', ') || '없음'})`,
  noGateway: (dir) => `실행 중인 gateway를 찾지 못함 (${dir}). deepbot의 platform에 'local'을 넣고 gateway를 시작해야 함`,
  severalGateways: (found) => `gateway가 여러 개 실행 중: ${found.join(', ')} — --name으로 고르기`,
  notConnected: 'gateway에 연결되어 있지 않음',
  notSent: 'gateway에 연결되어 있지 않아 보내지 못함',
  answerNotSent: 'gateway에 연결되어 있지 않아 답을 보내지 못함 — 다시 연결되면 질문이 다시 열림',
  noHarness: (bin) => `dsh: DeepSeek Harness CLI가 없음: ${bin} (DSH_BIN으로 경로 지정)\n`,
  selfHarness: 'dsh: DSH_BIN이 이 명령 자신을 가리킴 — harness CLI 경로로 지정\n',
  needsTty: 'dsh: 터미널(TTY)에서 실행해야 함\n',
  unknownOption: (flag) => `알 수 없는 옵션: ${flag}`,
  needsValue: (flag) => `${flag}에 값이 필요함`,
  usage: `dsh — 터미널에서 deepseek-bot과 대화

  dsh [--name <gateway>] [--socket <path>] [--tenant <name>] [--resume <conversation>]
  dsh <그 외 인자>   DeepSeek Harness CLI로 그대로 넘김 (DSH_BIN, 기본은 앱 안의 dsh)

  --name     연결할 gateway 이름 (deepbot 설정의 tuiName, 기본 default)
  --socket   gateway socket 경로를 직접 지정
  --tenant   tenant workspace로 대화 (tenantIsolation이 켜져 있어야 함)
  --resume   이전 대화 이어가기 (종료할 때 출력되는 id)
`,
  resumeHint: (conversation) => `이어서 대화하려면: dsh --resume ${conversation}\n`,
  tenantTalking: (tenant) => `tenant ${tenant} workspace에서 대화 중`,
  commands: {
    new: { hint: '새 대화 (같은 workspace)' },
    sessions: { hint: '터미널 대화 목록 (어느 tenant인지 표시)' },
    resume: { usage: '<번호|id>', hint: '목록의 대화 이어가기' },
    tenant: { usage: '[이름]', hint: '그 tenant workspace에서 새 대화 (이름 없이: 설정의 기본, 없으면 home)' },
    interview: { usage: '<주제>', hint: '딥인터뷰: 질문을 하나씩 받아 명확도를 올리고 spec으로 정리' },
    usage: { hint: '지금까지 쓴 토큰' },
    clear: { hint: '화면 비우기 (대화는 그대로)' },
    help: { hint: '이 도움말' },
    quit: { hint: '종료 (ctrl+c 두 번, ctrl+d도 같음)' },
    exit: { hint: '/quit과 같음' },
  },
  helpKeys: [
    '↵ 전송 · alt+↵ 줄바꿈 · esc 중단 · 휠/PgUp/PgDn 스크롤 · 드래그 복사',
    '/ 명령 · @ 파일 (tab으로 넣기) · ctrl+r 입력 기록 검색 · ctrl+o 생각·도구 결과 펼치기/접기',
  ],
  ago: (s) => s < 60 ? `${s}초 전` : s < 3600 ? `${Math.round(s / 60)}분 전` : s < 86400 ? `${Math.round(s / 3600)}시간 전` : `${Math.round(s / 86400)}일 전`,
  noSessions: '이 workspace에 터미널 대화가 아직 없음',
  untitled: '(제목 없음)',
  turns: (n) => `${n}턴`,
  resumeHow: '/resume <번호>로 이어가기',
  newConversation: '새 대화',
  defaultWorkspace: '기본 workspace',
  resumeUsage: '/resume <번호|id> — 번호는 /sessions 목록의 것',
  interviewUsage: '/interview <주제> — 무엇에 대해 인터뷰할지',
  couldNotSwitch: (message) => `전환하지 못함: ${message} — 이전 대화를 계속함`,
  planReviewRequested: 'plan 검토 요청',
  planReview: 'plan 검토',
  question: '질문',
  questionClosed: '질문이 닫힘',
  typeOwn: '직접 입력…',
  skipped: '(건너뜀)',
  earlier: (n) => `이전 대화 · 최근 ${n}개 메시지`,
  continuedHere: '── 여기부터 이어서 ──',
  jobRemoved: '정리됨 · 이 job을 만든 turn이 끝나면서 함께 정리됨',
  jobEnded: (status) => `종료됨 · ${status}`,
  loading: '불러오는 중',
  pasteCut: (n) => `붙여넣기가 커서 앞 ${n}자만 넣음`,
  askedToStop: (label) => `${label} 중단 요청`,
  askedToEnd: (id) => `${id} 종료 요청`,
  oneShot: '이 subagent는 one-shot이라 메시지를 받을 수 없음',
  sentTo: (label) => `→ ${label}에게 보냄`,
  shellNoInput: '셸에는 입력할 수 없음 — esc로 main으로',
  ctrlCAgain: 'Ctrl+C를 한 번 더 누르면 종료',
  copied: (n, osc52) => `복사됨 · ${n}자${osc52 ? ' (OSC 52)' : ''}`,
  choiceHint: '←→ 선택 · ↵ 확정 · 클릭',
  newLines: (n) => ` ↓ 새 줄 ${n} `,
  hints: {
    search: (query, found) => `(기록 검색) ${query}${found ? '' : ' · 일치 없음'} · ctrl+r 이전 · ↵ 고르기 · esc 취소`,
    completion: '↑↓ 고르기 · tab 넣기 · ↵ 실행 · esc 닫기',
    typing: '직접 입력 후 ↵ · esc 선택지로',
    question: (multi) => `↑↓ 이동${multi ? ' · space 선택' : ''} · ↵ 확정 · esc 건너뛰기 · 글자를 치면 직접 입력`,
    panel: '↑↓ 이동 · ↵ 열기 · esc 입력창으로',
    agent: (label) => `↵ ${label}에게 보내기 · ctrl+x 중단 · esc main으로`,
    job: 'ctrl+x 종료 · 휠 스크롤 · esc main으로',
    running: 'esc 중단 · 휠 스크롤 · 드래그 복사',
    idle: (panel) => `↵ 전송 · alt+↵ 줄바꿈 · 드래그 복사${panel ? ' · tab 패널' : ''} · /help · ctrl+c 종료`,
  },
  interview: '딥인터뷰',
  interviewPreparing: '첫 질문 준비 중',
  interviewDone: '완료',
  interviewAmbiguity: (ambiguity, target) => `모호도 ${ambiguity}% → 목표 ${target}% 이하`,
  interviewEstimate: '명확도는 모델의 자기 평가 — 측정값이 아님',
  interviewScores: ['목표', '제약', '성공 기준', '맥락'],
  moreLines: (n) => `${n}줄 더`,
  thinking: '생각 중…',
  working: '작업 중…',
  runningTool: (name) => `${name} 실행 중…`,
  queued: '대기 중',
  queuedCount: (n) => `${n}개 대기 중`,
  thought: (n, expanded) => `생각함 · ${n}자${expanded ? '' : ' · ctrl+o 펼치기'}`,
  diffUncompared: '… 변경이 커서 줄 단위로 비교하지 않음',
  diffWithheld: (n) => `… 큰 변경: 확실한 줄만 표시, ${n}줄 생략 (잘림)`,
  diffHead: '… 큰 변경이라 앞부분만 표시 (잘림)',
  diffNoneCertain: '… 큰 변경: 잘려서 확실히 말할 수 있는 줄이 없음 (잘림)',
  diffNoDifference: '… 큰 변경: 표시할 수 있는 앞부분에 차이 없음 (잘림)',
  noOutput: '(출력 없음)',
  gateway: {
    charsLeftOut: (n) => `(${n}자 생략)`,
    noSubagentMessaging: '이 배포에는 subagent 메시지 기능이 없음',
    parentNotRunning: '부모 대화의 turn이 끝나 있어 보낼 수 없음 — turn이 실행 중일 때만 가능',
    notResumable: '이 subagent에는 메시지를 보낼 수 없음 (one-shot이거나 직속 자식이 아님)',
    notSent: (message) => `보내지 못함: ${message}`,
    frameTooLarge: (type) => `${type} 프레임이 너무 커서 보내지 못함`,
    tooManyTerminals: '연결된 터미널이 너무 많음',
    tenantOff: '이 배포에는 tenant isolation이 켜져 있지 않음',
    badTenant: 'tenant 이름은 디렉터리 이름 하나: 비어 있지 않고, . 이나 .. 이 아니고, / 가 없어야 함',
    tenantMismatch: (tenant) => `이 대화는 ${tenant === null ? 'home workspace' : `tenant ${tenant}`}의 대화임`,
    questionClosed: '이미 닫힌 질문',
    notInPanel: '이 대화의 패널에 없는 항목',
    notSubagent: '이 대화의 subagent가 아님',
    needsText: '메시지에 내용이 필요함',
    notJob: '이 대화의 job이 아님',
    notButton: '이 대화의 버튼이 아님',
  },
}

const zh: Strings = {
  connecting: '连接中…',
  disconnected: (detail) => `已断开 · ${detail ?? '正在重连'}`,
  reconnectingIn: (ms) => `${ms}ms 后重连`,
  refused: (message) => `被拒绝：${message}`,
  unreadable: (error) => `无法读取 gateway 的响应：${error}`,
  noGatewayNamed: (name, found) => `没有名为 '${name}' 的 gateway 在运行（找到：${found.join(', ') || '无'}）`,
  noGateway: (dir) => `没有找到正在运行的 gateway（${dir}）。请在 deepbot 的 platform 中加入 'local' 并启动 gateway`,
  severalGateways: (found) => `有多个 gateway 在运行：${found.join(', ')} — 用 --name 选择一个`,
  notConnected: '未连接到 gateway',
  notSent: '未发送：未连接到 gateway',
  answerNotSent: '回答未发送：未连接到 gateway — 重新连接后问题会再次打开',
  noHarness: (bin) => `dsh: 找不到 DeepSeek Harness CLI：${bin}（用 DSH_BIN 指定路径）\n`,
  selfHarness: 'dsh: DSH_BIN 指向了这个命令本身 — 请指定 harness CLI 的路径\n',
  needsTty: 'dsh: 需要在终端（TTY）中运行\n',
  unknownOption: (flag) => `未知选项：${flag}`,
  needsValue: (flag) => `${flag} 需要一个值`,
  usage: `dsh — 在终端中与 deepseek-bot 对话

  dsh [--name <gateway>] [--socket <path>] [--tenant <name>] [--resume <conversation>]
  dsh <其他参数>   原样交给 DeepSeek Harness CLI（DSH_BIN，默认为应用内的 dsh）

  --name     要连接的 gateway 名称（deepbot 配置中的 tuiName，默认 default）
  --socket   直接指定 gateway 的 socket 路径
  --tenant   在某个 tenant 的 workspace 中对话（需开启 tenantIsolation）
  --resume   继续之前的对话（退出时打印的 id）
`,
  resumeHint: (conversation) => `继续此对话：dsh --resume ${conversation}\n`,
  tenantTalking: (tenant) => `正在 tenant ${tenant} 的 workspace 中对话`,
  commands: {
    new: { hint: '新对话（同一 workspace）' },
    sessions: { hint: '终端对话列表（显示所属 tenant）' },
    resume: { usage: '<编号|id>', hint: '继续列表中的对话' },
    tenant: { usage: '[名称]', hint: '在该 tenant 的 workspace 中开始新对话（不带名称：配置的默认值，否则为 home）' },
    interview: { usage: '<主题>', hint: '深度访谈：一次一个问题，直到清晰，再整理成 spec' },
    usage: { hint: '目前用掉的 token' },
    clear: { hint: '清空屏幕（对话保留）' },
    help: { hint: '本帮助' },
    quit: { hint: '退出（按两次 ctrl+c，或 ctrl+d）' },
    exit: { hint: '与 /quit 相同' },
  },
  helpKeys: [
    '↵ 发送 · alt+↵ 换行 · esc 中断 · 滚轮/PgUp/PgDn 滚动 · 拖动复制',
    '/ 命令 · @ 文件（tab 插入） · ctrl+r 搜索输入历史 · ctrl+o 展开/折叠思考和工具输出',
  ],
  ago: (s) => s < 60 ? `${s} 秒前` : s < 3600 ? `${Math.round(s / 60)} 分钟前` : s < 86400 ? `${Math.round(s / 3600)} 小时前` : `${Math.round(s / 86400)} 天前`,
  noSessions: '这个 workspace 里还没有终端对话',
  untitled: '（无标题）',
  turns: (n) => `${n} 轮`,
  resumeHow: '用 /resume <编号> 继续',
  newConversation: '新对话',
  defaultWorkspace: '默认 workspace',
  resumeUsage: '/resume <编号|id> — 编号来自 /sessions 列表',
  interviewUsage: '/interview <主题> — 要访谈的内容',
  couldNotSwitch: (message) => `无法切换：${message} — 继续当前对话`,
  planReviewRequested: '请求审阅计划',
  planReview: '计划审阅',
  question: '问题',
  questionClosed: '问题已关闭',
  typeOwn: '自行输入…',
  skipped: '（已跳过）',
  earlier: (n) => `之前的对话 · 最近 ${n} 条消息`,
  continuedHere: '── 从这里继续 ──',
  jobRemoved: '已清理 · 启动它的回合结束时一并清理',
  jobEnded: (status) => `已结束 · ${status}`,
  loading: '加载中',
  pasteCut: (n) => `粘贴内容过长：只保留前 ${n} 个字符`,
  askedToStop: (label) => `已请求 ${label} 停止`,
  askedToEnd: (id) => `已请求结束 ${id}`,
  oneShot: '这个 subagent 是一次性的，不能接收消息',
  sentTo: (label) => `→ 已发送给 ${label}`,
  shellNoInput: 'shell 不接受输入 · esc 返回 main',
  ctrlCAgain: '再按一次 Ctrl+C 退出',
  copied: (n, osc52) => `已复制 · ${n} 个字符${osc52 ? '（OSC 52）' : ''}`,
  choiceHint: '←→ 选择 · ↵ 确认 · 点击',
  newLines: (n) => ` ↓ ${n} 条新内容 `,
  hints: {
    search: (query, found) => `（历史搜索）${query}${found ? '' : ' · 无匹配'} · ctrl+r 更早 · ↵ 选择 · esc 取消`,
    completion: '↑↓ 选择 · tab 插入 · ↵ 执行 · esc 关闭',
    typing: '输入后按 ↵ · esc 返回选项',
    question: (multi) => `↑↓ 移动${multi ? ' · space 选择' : ''} · ↵ 确认 · esc 跳过 · 直接打字可自行回答`,
    panel: '↑↓ 移动 · ↵ 打开 · esc 返回输入框',
    agent: (label) => `↵ 发送给 ${label} · ctrl+x 停止 · esc 返回 main`,
    job: 'ctrl+x 结束 · 滚轮滚动 · esc 返回 main',
    running: 'esc 中断 · 滚轮滚动 · 拖动复制',
    idle: (panel) => `↵ 发送 · alt+↵ 换行 · 拖动复制${panel ? ' · tab 面板' : ''} · /help · ctrl+c 退出`,
  },
  interview: '深度访谈',
  interviewPreparing: '正在准备第一个问题',
  interviewDone: '完成',
  interviewAmbiguity: (ambiguity, target) => `模糊度 ${ambiguity}% → 目标 ${target}% 以下`,
  interviewEstimate: '清晰度是模型的自我评估，不是测量值',
  interviewScores: ['目标', '约束', '成功标准', '背景'],
  moreLines: (n) => `还有 ${n} 行`,
  thinking: '思考中…',
  working: '处理中…',
  runningTool: (name) => `正在运行 ${name}…`,
  queued: '排队中',
  queuedCount: (n) => `${n} 条排队中`,
  thought: (n, expanded) => `已思考 · ${n} 个字符${expanded ? '' : ' · ctrl+o 展开'}`,
  diffUncompared: '… 变更过大，不逐行比较',
  diffWithheld: (n) => `… 大变更：只显示能确定的行，省略 ${n} 行（已截断）`,
  diffHead: '… 大变更：只显示开头（已截断）',
  diffNoneCertain: '… 大变更：截断后没有能确定的行（已截断）',
  diffNoDifference: '… 大变更：可显示的开头部分没有差异（已截断）',
  noOutput: '（无输出）',
  gateway: {
    charsLeftOut: (n) => `（省略 ${n} 个字符）`,
    noSubagentMessaging: '此部署无法给 subagent 发消息',
    parentNotRunning: '未发送：父对话没有正在进行的回合 — 只能在回合进行时发送',
    notResumable: '这个 subagent 不接收消息（它是一次性的，或不是直接子级）',
    notSent: (message) => `未发送：${message}`,
    frameTooLarge: (type) => `${type} 帧过大，无法发送`,
    tooManyTerminals: '连接的终端过多',
    tenantOff: '此部署未开启 tenant isolation',
    badTenant: 'tenant 名称必须是单个目录名：不能为空，不能是 . 或 ..，不能含 /',
    tenantMismatch: (tenant) => `这个对话属于${tenant === null ? ' home workspace' : ` tenant ${tenant}`}`,
    questionClosed: '该问题已关闭',
    notInPanel: '不在此对话的面板中',
    notSubagent: '不是此对话的 subagent',
    needsText: '消息需要内容',
    notJob: '不是此对话的 job',
    notButton: '不是此对话的按钮',
  },
}

const CATALOG: Record<Language, Strings> = { en, ko, zh }

/** One language's words, for the gateway, which speaks the deployment's language. */
export function stringsFor(language: Language): Strings {
  return CATALOG[language] ?? en
}

/** English until told otherwise: `dsh` sets the environment's language at start (main.ts). */
let current: Language = 'en'

/** The terminal's words in its current language. */
export function t(): Strings {
  return CATALOG[current]
}

export function language(): Language {
  return current
}

/** Switch the terminal's language: at start from the environment, then to the gateway's. */
export function setLanguage(next: Language): void {
  current = next
}
