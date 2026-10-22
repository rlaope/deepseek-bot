/**
 * What the adapter itself says on a platform, in each language the `language` setting takes.
 * The Korean set is the plain 반말 register the bot has always used, so an existing Korean
 * deployment reads the same. The model's own answers are not here.
 */
import { LANGUAGES, type Language } from './i18n.js'

const en = {
  restartLost: 'A restart cut off what I was working on. Could you say it again?',
  sessionLost: 'I could not find the earlier record of this conversation, so I started a new one. If something said before matters, tell me again.',
  alreadyHandled: 'That request was already handled.',
  notYours: 'Only the person who asked can decide this one. Please answer it yourself.',
  approved: 'Allowed. Carrying on.',
  denied: 'Denied.',
  approvalNeeded: (reason: string) => `⚠️ I need permission: ${reason}`,
  approvalHowButtons: 'Press a button below, or reply *allow* / *deny*.',
  approvalHowTerminal: 'Choose below: ↑↓ or its number, and ↵, or a click; esc denies.',
  approvalHowWords: 'Reply *allow* to run it, or *deny* to refuse.',
  approvalTimeout: (minutes: number) => `(With no answer, it is denied after ${minutes} min.)`,
  allow: 'Allow',
  deny: 'Deny',
  stoppedWithdrawn: (n: number) => `Stopped. Withdrew ${n} waiting message${n === 1 ? '' : 's'}.`,
  stoppedStarting: 'Stopped. The work that was starting was halted.',
  nothingRunning: 'Nothing is running right now.',
  timedOut: 'It ran out of time, so I stopped.',
  backgroundStopped: (label: string, minutes: number) => `A background job was still running after ${minutes} min, so I stopped it: ${label}`,
  backgroundTooMany: 'Too many background jobs are running, so I stopped the one this answer started. I cannot tell you when it would have finished.',
  stopped: 'Stopped.',
  unfinished: (kind: string) => `I could not finish (${kind}). Could you say it again?`,
  unknownReason: 'unknown reason',
  runFailed: (message: string) => `The run failed: ${message}`,
  uploadFailed: (name: string) => `I could not upload ${name}.`,
  charsLeftOut: (n: number) => `(${n} characters left out)`,
  progress: '⏳ {name} is working…',
  working: 'Working…',
  tools: (n: number, last: string) => `${n} tool${n === 1 ? '' : 's'} (${last})`,
  usageLine: (label: string, turns: number, input: string, cachedShare: number, output: string) =>
    `${label}: ${turns} turn${turns === 1 ? '' : 's'} · input ${input} (${cachedShare}% cached) · output ${output}`,
  usageThis: 'This conversation',
  usageAll: (n: number) => `All (${n} conversations)`,
  usageNoPrice: 'No cost is shown: the harness does not expose model prices, so this reports tokens only.',
}

export type Messages = typeof en

const ko: Messages = {
  restartLost: '재시작하느라 하던 작업이 끊겼어. 다시 말해줄래?',
  sessionLost: '이 대화의 이전 기록을 찾을 수 없어서 새로 시작했어. 앞에서 한 얘기가 필요하면 다시 알려줘.',
  alreadyHandled: '이미 처리된 요청이야.',
  notYours: '이 요청을 승인할 사람이 아니야 — 요청한 사람이 직접 답해줘.',
  approved: '허용했어 — 계속할게.',
  denied: '거부했어.',
  approvalNeeded: (reason) => `⚠️ 권한이 필요해: ${reason}`,
  approvalHowButtons: '아래 버튼을 누르거나 *허용* / *거부* 라고 답해줘.',
  approvalHowTerminal: '아래에서 골라줘: ↑↓ 나 번호, 그리고 ↵, 또는 클릭. esc는 거절.',
  approvalHowWords: '실행하려면 *허용*, 거부하려면 *거부* 라고 답해줘.',
  approvalTimeout: (minutes) => `(답이 없으면 ${minutes}분 뒤 자동으로 거부돼.)`,
  allow: '허용',
  deny: '거부',
  stoppedWithdrawn: (n) => `중단했어 — 기다리던 메시지 ${n}개를 취소했어.`,
  stoppedStarting: '중단했어 — 시작 중이던 작업을 멈췄어.',
  nothingRunning: '지금 돌고 있는 작업이 없어.',
  timedOut: '시간이 초과돼서 멈췄어.',
  backgroundStopped: (label, minutes) => `${minutes}분이 지나도 끝나지 않아서 백그라운드 작업을 멈췄어: ${label}`,
  backgroundTooMany: '백그라운드 작업이 너무 많이 돌고 있어서 방금 시작한 작업은 멈췄어. 끝나면 알려준다던 건 못 지켜.',
  stopped: '중단했어.',
  unfinished: (kind) => `작업을 끝내지 못했어 (${kind}). 다시 말해줄래?`,
  unknownReason: '이유 모름',
  runFailed: (message) => `실행에 실패했어: ${message}`,
  uploadFailed: (name) => `${name} 파일을 올리지 못했어.`,
  charsLeftOut: (n) => `(${n}자 생략)`,
  progress: '⏳ {name} 작업 중…',
  working: '작업 중…',
  tools: (n, last) => `${n}개 도구 (${last})`,
  usageLine: (label, turns, input, cachedShare, output) => `${label}: ${turns}턴 · 입력 ${input} (캐시 ${cachedShare}%) · 출력 ${output}`,
  usageThis: '이 대화',
  usageAll: (n) => `전체 (${n}개 대화)`,
  usageNoPrice: '금액은 하네스가 모델 단가를 노출하지 않아 계산하지 않습니다 — 토큰만 보고합니다.',
}

const zh: Messages = {
  restartLost: '重启打断了正在进行的工作。能再说一遍吗？',
  sessionLost: '找不到这段对话之前的记录，所以重新开始了。之前说过的内容如果需要，请再告诉我一次。',
  alreadyHandled: '这个请求已经处理过了。',
  notYours: '只有提出请求的人才能决定这一项，请由本人回复。',
  approved: '已允许，继续执行。',
  denied: '已拒绝。',
  approvalNeeded: (reason) => `⚠️ 需要权限：${reason}`,
  approvalHowButtons: '点击下方按钮，或回复 *允许* / *拒绝*。',
  approvalHowTerminal: '在下方选择：↑↓ 或编号，再按 ↵，或点击；esc 拒绝。',
  approvalHowWords: '回复 *允许* 即执行，回复 *拒绝* 即取消。',
  approvalTimeout: (minutes) => `（${minutes} 分钟内无人回复将自动拒绝。）`,
  allow: '允许',
  deny: '拒绝',
  stoppedWithdrawn: (n) => `已停止，撤回了 ${n} 条等待中的消息。`,
  stoppedStarting: '已停止，正在启动的工作已中止。',
  nothingRunning: '当前没有正在进行的工作。',
  timedOut: '超时了，已停止。',
  backgroundStopped: (label, minutes) => `后台任务运行 ${minutes} 分钟后仍未结束，已停止：${label}`,
  backgroundTooMany: '同时运行的后台任务太多，刚才启动的任务已停止，无法在它结束时通知你。',
  stopped: '已停止。',
  unfinished: (kind) => `没能完成（${kind}）。能再说一遍吗？`,
  unknownReason: '原因不明',
  runFailed: (message) => `执行失败：${message}`,
  uploadFailed: (name) => `无法上传 ${name}。`,
  charsLeftOut: (n) => `（省略了 ${n} 个字符）`,
  progress: '⏳ {name} 正在处理…',
  working: '正在处理…',
  tools: (n, last) => `${n} 个工具（${last}）`,
  usageLine: (label, turns, input, cachedShare, output) => `${label}：${turns} 轮 · 输入 ${input}（缓存 ${cachedShare}%） · 输出 ${output}`,
  usageThis: '本对话',
  usageAll: (n) => `全部（${n} 个对话）`,
  usageNoPrice: '不显示费用：harness 不提供模型单价，因此只报告 token 数。',
}

const CATALOG: Record<Language, Messages> = { en, ko, zh }

export function messages(language: Language): Messages {
  return CATALOG[language] ?? en
}

/**
 * Whole messages that mean one thing, in every language at once: a deployment set to Korean
 * still stops on "stop", and a Chinese speaker in it is understood. The first cancel word is
 * what the terminal sends for esc, so English leads.
 */
const WORDS: Record<Language, { cancel: string[]; usage: string[]; approve: string[]; deny: string[] }> = {
  en: { cancel: ['stop', 'cancel'], usage: ['usage'], approve: ['yes', 'allow', 'ok'], deny: ['no', 'deny'] },
  ko: { cancel: ['그만', '중단', '취소', '멈춰'], usage: ['사용량', '비용', '토큰', '얼마나 썼어'], approve: ['허용', '승인', '응', 'ㅇㅇ', 'ㅇ'], deny: ['거부', '아니', '안돼', 'ㄴㄴ'] },
  zh: { cancel: ['停止', '取消', '停下', '别做了'], usage: ['用量', '费用', '花了多少'], approve: ['允许', '批准', '同意', '可以'], deny: ['拒绝', '不行', '不要', '不'] },
}

export function defaultWords(kind: 'cancel' | 'usage' | 'approve' | 'deny'): string[] {
  return LANGUAGES.flatMap((l) => WORDS[l][kind])
}
