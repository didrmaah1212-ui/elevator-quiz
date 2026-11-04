import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from './supabase'
import { questions, totalQuestions } from './questions'
import './App.css'

const TEAMS = [1, 2, 3, 5]
const REWARDS = { plus10: '🎁 +10점', minus5: '💥 -5점', plus20: '🌟 +20점', swap: '🔄 점수 교환권' }
const INITIAL_COUNTS = { plus10: 12, minus5: 9, plus20: 5, swap: 2 }
const SESSION_KEY = 'elevator-quiz-team-session-v2'
const EMPTY_GAME = { phase: 'lobby', current_question: 1, game_id: null }
const EMPTY_BUZZER = { status: 'waiting', active_team: null, last_attempt_team: null, deadline_at: null, question_number: 1 }
const humanError = (error) => {
  const msg = error?.message || String(error)
  if (/team already occupied/i.test(msg)) return '이미 다른 기기에서 이 조에 접속 중입니다. 기존 기기에서 퇴장하거나 20초 정도 기다려 주세요.'
  if (/team session expired|invalid/i.test(msg)) return '조 접속이 만료되었습니다. 다시 입장해 주세요.'
  if (/host authorization/i.test(msg)) return '진행자 권한이 없습니다. 등록된 진행자 계정으로 로그인해 주세요.'
  return msg
}
function readSession() {
  try { const v = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); return v && TEAMS.includes(v.team) && typeof v.token === 'string' ? v : null } catch { return null }
}
function formatSeconds(deadline, now) { return deadline ? Math.max(0, (new Date(deadline).getTime() - now) / 1000).toFixed(1) : '0.0' }

export default function App() {
  const [role, setRole] = useState(null)
  const [teamSession, setTeamSession] = useState(readSession)
  const [hostUser, setHostUser] = useState(null)
  const [hostAuthorized, setHostAuthorized] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [game, setGame] = useState(EMPTY_GAME)
  const [buzzer, setBuzzer] = useState(EMPTY_BUZZER)
  const [teams, setTeams] = useState([])
  const [lobby, setLobby] = useState([])
  const [attempts, setAttempts] = useState([])
  const [reward, setReward] = useState({ status: 'not_registered' })
  const [counts, setCounts] = useState(INITIAL_COUNTS)
  const [selected, setSelected] = useState(null)
  const [swapTarget, setSwapTarget] = useState(null)
  const [now, setNow] = useState(Date.now())
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [connected, setConnected] = useState(false)
  const [loading, setLoading] = useState(true)
  const lastQuestion = useRef(null)
  const refreshInFlight = useRef(false)
  const finalizeInFlight = useRef(false)
  const sessionRef = useRef(teamSession)
  const gameRef = useRef(game)
  const buzzerRef = useRef(buzzer)
  const roleRef = useRef(role)
  useEffect(() => { sessionRef.current = teamSession }, [teamSession])
  useEffect(() => { gameRef.current = game }, [game])
  useEffect(() => { buzzerRef.current = buzzer }, [buzzer])
  useEffect(() => { roleRef.current = role }, [role])

  const rpc = useCallback(async (name, args = {}) => {
    const { data, error } = await supabase.rpc(name, args)
    if (error) throw error
    return data
  }, [])

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return
    refreshInFlight.current = true
    try {
      const [g, b, t, a, l, c] = await Promise.all([
        supabase.from('quiz_game_state').select('*').eq('id', 1).single(),
        supabase.from('quiz_buzzer').select('*').eq('id', 1).single(),
        supabase.from('quiz_teams').select('team_number,score').order('team_number'),
        supabase.from('quiz_attempts').select('id,game_id,question_number,team_number,selected_answer,correct,attempted_at').order('id', { ascending: true }),
        supabase.rpc('quiz_get_lobby'),
        supabase.rpc('quiz_reward_counts'),
      ])
      for (const res of [g, b, t, a, l, c]) if (res.error) throw res.error
      const current = g.data || EMPTY_GAME
      setGame(current)
      setBuzzer(b.data || EMPTY_BUZZER)
      setTeams(t.data || [])
      setAttempts((a.data || []).filter(x => x.game_id === current.game_id && x.question_number === current.current_question))
      setLobby(l.data || [])
      setCounts(Object.fromEntries((c.data || []).map(x => [x.reward_type, Number(x.remaining_count)])))
      if (current.phase === 'explanation') {
        const r = await supabase.rpc('quiz_reward_state', { p_question: current.current_question })
        if (r.error) throw r.error
        setReward(r.data || { status: 'not_registered' })
      } else setReward({ status: 'not_registered' })
      if (lastQuestion.current !== `${current.game_id}:${current.current_question}`) {
        lastQuestion.current = `${current.game_id}:${current.current_question}`
        setSelected(null)
        setSwapTarget(null)
        setMessage('')
      }
      setConnected(true)
    } catch (e) {
      setConnected(false)
      setMessage(`데이터를 불러오지 못했습니다: ${humanError(e)}`)
    } finally { setLoading(false); refreshInFlight.current = false }
  }, [])

  useEffect(() => {
    let active = true
    supabase.auth.getUser().then(async ({ data, error }) => {
      if (!active || error || !data?.user) return
      setHostUser(data.user)
      const result = await supabase.rpc('quiz_is_host')
      if (active && !result.error) setHostAuthorized(Boolean(result.data))
    })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return
      setHostUser(session?.user || null)
      if (!session?.user) setHostAuthorized(false)
    })
    return () => { active = false; listener.subscription.unsubscribe() }
  }, [])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 1200)
    const clock = setInterval(() => setNow(Date.now()), 100)
    return () => { clearInterval(timer); clearInterval(clock) }
  }, [refresh])

  useEffect(() => {
    if (!teamSession) return
    let active = true
    const heartbeat = async () => {
      const s = sessionRef.current
      if (!s) return
      try {
        const ok = await rpc('quiz_heartbeat', { p_team: s.team, p_token: s.token })
        if (active && !ok) {
          sessionStorage.removeItem(SESSION_KEY)
          setTeamSession(null)
          setRole(null)
          setMessage('조 접속이 종료되었습니다. 다시 입장해 주세요.')
        }
      } catch (e) { if (active) setMessage(`접속 유지 오류: ${humanError(e)}`) }
    }
    heartbeat()
    const timer = setInterval(heartbeat, 5000)
    return () => { active = false; clearInterval(timer) }
  }, [teamSession?.team, teamSession?.token, rpc])

  useEffect(() => {
    if (game.phase !== 'question' || buzzer.status !== 'active' || buzzer.question_number !== game.current_question || !buzzer.deadline_at) return
    if (new Date(buzzer.deadline_at).getTime() > now || finalizeInFlight.current) return
    finalizeInFlight.current = true
    rpc('quiz_finalize').then(refresh).catch(e => setMessage(humanError(e))).finally(() => { finalizeInFlight.current = false })
  }, [now, game.phase, game.current_question, buzzer.status, buzzer.question_number, buzzer.deadline_at, refresh, rpc])

  const act = async (fn) => {
    if (busy) return
    setBusy(true); setMessage('')
    try { await fn(); await refresh() } catch (e) { setMessage(humanError(e)) } finally { setBusy(false) }
  }
  const team = teamSession?.team
  const args = (extra = {}) => ({ p_team: team, p_token: teamSession.token, ...extra })
  const current = questions[game.current_question]
  const myLobby = lobby.find(x => x.team_number === team)
  const allReady = lobby.length === 4 && lobby.every(x => x.is_online && x.is_ready)
  const buzzerCurrent = buzzer.question_number === game.current_question
  const myTurn = role === 'player' && buzzerCurrent && buzzer.status === 'active' && buzzer.active_team === team && game.phase === 'question'
  const lockedOut = role === 'player' && buzzerCurrent && buzzer.last_attempt_team === team
  const wrongOptions = new Set(attempts.filter(x => x.correct === false && x.selected_answer).map(x => String(x.selected_answer)))
  const winner = reward?.winner_team
  const recipient = reward?.recipient_team
  const canChoose = role === 'player' && team === winner && reward?.status === 'pending' && recipient == null
  const canOpen = role === 'player' && team === recipient && reward?.status === 'pending'
  const canSwap = role === 'player' && team === recipient && reward?.status === 'swap_pending'
  const timeLeft = buzzerCurrent && buzzer.status === 'active' ? formatSeconds(buzzer.deadline_at, now) : '0.0'

  const join = (t) => act(async () => {
    const token = await rpc('quiz_join_team', { p_team: t })
    if (!token) throw Error('조 입장에 실패했습니다.')
    const session = { team: t, token }
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session))
    setTeamSession(session); setRole('player')
  })
  const leave = () => act(async () => {
    if (teamSession) await rpc('quiz_leave_team', args())
    sessionStorage.removeItem(SESSION_KEY)
    setTeamSession(null); setRole(null)
  })
  const hostLogin = (event) => {
    event.preventDefault()
    act(async () => {
      const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
      if (error) throw error
      setPassword('')
      const ok = await rpc('quiz_is_host')
      if (!ok) { await supabase.auth.signOut(); throw Error('등록된 진행자 계정이 아닙니다.') }
      setHostUser(data.user); setHostAuthorized(true); setRole('host')
    })
  }
  const hostLogout = () => act(async () => {
    const { error } = await supabase.auth.signOut()
    if (error) throw error
    setHostAuthorized(false); setHostUser(null); setRole(null)
  })
  const hostAction = (name, params = {}) => act(async () => {
    const ok = await rpc(name, params)
    if (!ok) throw Error('현재 상태에서 실행할 수 없습니다. 대기실 준비 상태 또는 보상 처리를 확인해 주세요.')
  })
  const submit = (answer) => act(async () => {
    if (!myTurn) throw Error('현재 답변할 차례가 아닙니다.')
    if (wrongOptions.has(answer)) throw Error('이미 오답으로 처리된 보기입니다.')
    setSelected(answer)
    const result = await rpc('quiz_submit', args({ p_question: game.current_question, p_answer: answer }))
    const messages = { correct: '정답! 해설과 랜덤박스가 공개됩니다.', wrong_retry: '오답입니다. 다른 조가 도전한 뒤 다시 참여할 수 있습니다.', all_attempted: '모든 조가 도전하여 해설이 공개됐습니다.', invalid_answer: '선택할 수 없는 보기입니다.', not_your_turn: '답변 시간이 끝났거나 다른 조의 차례입니다.', not_active: '도전권이 종료되었습니다.' }
    setMessage(messages[result] || `제출 결과: ${result}`)
  })
  const rewardAction = (name, params = {}) => act(async () => {
    const result = await rpc(name, args({ p_question: game.current_question, ...params }))
    const messages = { chosen: '랜덤박스를 받을 조가 정해졌습니다.', plus10: '+10점!', minus5: '-5점!', plus20: '+20점!', swap: '점수 교환권! 사용할지 선택해 주세요.', swapped: '점수가 교환되었습니다.', skipped: '점수 교환권을 사용하지 않았습니다.', not_allowed: '이 조에서는 지금 실행할 수 없습니다.', invalid_target: '다른 조를 선택해 주세요.', already_opened: '이미 개봉한 상자입니다.' }
    setMessage(messages[result] || `보상 결과: ${result}`)
  })

  const scoreboard = <div className="scoreboard">{TEAMS.map(t => <div className={`score ${team === t ? 'my-team' : ''}`} key={t}><span>{t}조 {lobby.find(x => x.team_number === t)?.is_online ? '🟢' : '⚪'}</span><strong>{teams.find(x => x.team_number === t)?.score ?? 0}점</strong></div>)}</div>
  const countsView = <div className="reward-counts">{Object.entries(REWARDS).map(([kind, label]) => <span key={kind}>{label} <b>{counts[kind] ?? INITIAL_COUNTS[kind]}개</b></span>)}</div>

  return <main className="container quiz-app">
    <header className="quiz-header"><div><h1>🛗 승강기 안전관리법 퀴즈</h1><p>4개 조 대항전 · 28문제 · 랜덤박스</p></div><div className="connection">{connected ? '● 서버 연결됨' : '○ 연결 확인 중'}</div></header>
    {message && <div className="quiz-message" role="status">{message}</div>}
    {loading ? <section className="card">게임 정보를 불러오는 중...</section> : <>
      {!role && <section className="card"><h2>참가 방식을 선택하세요</h2><p>진행자 1명과 1·2·3·5조가 각자의 기기로 접속합니다.</p><div className="choice-grid"><button onClick={() => setRole('host')}>🎤 진행자로 입장</button><button onClick={() => setRole('player')}>👥 참가 조로 입장</button></div></section>}
      {role === 'player' && !teamSession && <section className="card"><h2>참가 조 선택</h2><p>조별로 한 기기만 입장할 수 있습니다. 같은 브라우저 탭을 새로고침하면 접속이 유지됩니다.</p><div className="choice-grid">{TEAMS.map(t => <button key={t} disabled={busy || lobby.find(x => x.team_number === t)?.is_online} onClick={() => join(t)}>{t}조 {lobby.find(x => x.team_number === t)?.is_online ? '· 접속 중' : '· 입장'}</button>)}</div><button className="secondary" onClick={() => setRole(null)}>뒤로</button></section>}
      {role === 'host' && !hostAuthorized && <section className="card"><h2>진행자 로그인</h2><form className="login-form" onSubmit={hostLogin}><label>이메일<input type="email" required autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} /></label><label>비밀번호<input type="password" required autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label><button type="submit" disabled={busy}>로그인</button></form><button className="secondary" onClick={() => setRole(null)}>뒤로</button></section>}
      {role === 'host' && hostAuthorized && <div className="role-bar">🎤 진행자 · {hostUser?.email}<button onClick={hostLogout} disabled={busy}>로그아웃</button></div>}
      {role === 'player' && teamSession && <div className="role-bar">👥 {team}조 참가 중<button onClick={leave} disabled={busy}>조 퇴장</button></div>}
      {((role === 'host' && hostAuthorized) || (role === 'player' && teamSession)) && <>
        {scoreboard}
        {game.phase === 'lobby' && <section className="card"><h2>🏁 게임 대기실</h2><p>네 조 모두 온라인 상태에서 준비 완료를 눌러야 시작할 수 있습니다.</p><div className="lobby-grid">{TEAMS.map(t => { const s = lobby.find(x => x.team_number === t); return <div className="lobby-team" key={t}><b>{t}조</b><span>{s?.is_online ? '🟢 접속' : '⚪ 미접속'}</span><span>{s?.is_ready ? '✅ 준비 완료' : '⏳ 대기 중'}</span></div> })}</div>{role === 'player' && <button disabled={busy} onClick={() => act(async () => { const ok = await rpc('quiz_set_ready', args({ p_ready: !myLobby?.is_ready })); if (!ok) throw Error('지금은 준비 상태를 변경할 수 없습니다.') })}>{myLobby?.is_ready ? '준비 취소' : '준비 완료'}</button>}{role === 'host' && <button disabled={busy || !allReady} onClick={() => hostAction('quiz_host_start')}>🚀 게임 시작 {allReady ? '' : '(모든 조 준비 필요)'}</button>}</section>}
        {game.phase === 'finished' ? <section className="card"><h2>🏆 게임 종료!</h2><p>28문제 진행이 끝났습니다. 최종 점수를 확인하세요.</p>{role === 'host' && <button disabled={busy} onClick={() => { if (window.confirm('모든 점수와 게임 진행 상황을 초기화하고 새 게임을 시작할까요?')) hostAction('quiz_host_reset') }}>새 게임 초기화</button>}</section> : null}
        {(game.phase === 'question' || game.phase === 'explanation') && <>
          <section className="card question-card"><div className="question-meta"><span>문제 {game.current_question} / {totalQuestions}</span><span>{current?.type === 'ox' ? 'O / X' : '객관식'}</span></div><h2>{current?.question || '문제 데이터를 찾을 수 없습니다.'}</h2><div className="options">{(current?.options || []).map((option, i) => { const answer = String(i + 1); const wrong = wrongOptions.has(answer); const correctShown = game.phase === 'explanation' && String(current.correctAnswer) === answer; return <button key={answer} className={`${wrong ? 'wrong-option' : ''} ${correctShown ? 'correct-option' : ''} ${selected === answer ? 'selected' : ''}`} disabled={busy || !myTurn || wrong || game.phase !== 'question'} onClick={() => submit(answer)}>{option}{wrong ? ' ✕' : ''}{correctShown ? ' ✓' : ''}</button> })}</div>
            {game.phase === 'question' && <><div className="buzzer-status">{buzzerCurrent && buzzer.status === 'active' ? <><b>{buzzer.active_team}조 도전 중</b><span className="countdown">⏱ {timeLeft}초</span></> : <b>🔔 도전권 대기 중</b>}</div>{role === 'player' && <button className="buzzer-button" disabled={busy || buzzer.status !== 'waiting' || lockedOut || !buzzerCurrent} onClick={() => act(async () => { const ok = await rpc('quiz_claim', args()); if (!ok) throw Error('도전권을 획득하지 못했습니다. 다른 조가 먼저 눌렀거나 바로 이전 도전자입니다.') })}>{lockedOut ? '다른 조의 도전 후 재참여 가능' : myTurn ? '답변을 선택하세요' : '🔔 도전권 누르기'}</button>}{role === 'host' && <button className="secondary" disabled={busy || buzzer.status === 'active'} onClick={() => hostAction('quiz_host_reveal')}>정답 및 해설 공개 (수동)</button>}<p className="muted">도전권을 얻으면 5초 안에 보기를 눌러 즉시 제출합니다. 시간 초과 시 저장된 답이 없다면 오답 처리됩니다.</p></>}
            {game.phase === 'explanation' && <div className="explanation"><h3>📖 정답 및 해설</h3><p><b>정답:</b> {current?.options?.[Number(current?.correctAnswer) - 1]}</p><p>{current?.explanation}</p><p className="legal-ref">법령 근거: {current?.legalReference}</p></div>}
          </section>
          {game.phase === 'question' && attempts.length > 0 && <section className="card"><h3>도전 기록</h3><p>{attempts.map(x => `${x.team_number}조 ${x.correct ? '정답' : '오답'}`).join(' · ')}</p></section>}
          {game.phase === 'explanation' && <section className="card reward-card"><h2>🎁 랜덤박스</h2>{countsView}{reward.status === 'not_registered' ? <p>이번 문제는 랜덤박스 당첨 조가 없습니다.</p> : <><p>정답 조: <b>{winner}조</b>{recipient != null ? ` · 수령 조: ${recipient}조` : ''}</p>{canChoose && <><h3>상자를 직접 받을까요, 다른 조에 넘길까요?</h3><div className="choice-grid">{TEAMS.map(t => <button key={t} disabled={busy} onClick={() => rewardAction('quiz_choose_recipient', { p_recipient: t })}>{t === team ? '내 조가 받기' : `${t}조에 넘기기`}</button>)}</div></>}{canOpen && <button disabled={busy} onClick={() => rewardAction('quiz_open_reward')}>🎁 랜덤박스 열기</button>}{canSwap && <><h3>점수 교환권을 사용하시겠습니까?</h3><div className="choice-grid">{TEAMS.filter(t => t !== team).map(t => <button className={swapTarget === t ? 'selected' : ''} key={t} onClick={() => setSwapTarget(t)}>{t}조와 교환</button>)}</div><button disabled={busy || !swapTarget} onClick={() => rewardAction('quiz_resolve_swap', { p_use: true, p_target: swapTarget })}>점수 교환 실행</button><button className="secondary" disabled={busy} onClick={() => rewardAction('quiz_resolve_swap', { p_use: false, p_target: null })}>사용하지 않기</button></>}{reward.status === 'pending' && !canChoose && !canOpen && <p>상자 수령 조의 선택을 기다리는 중입니다.</p>}{reward.status === 'swap_pending' && !canSwap && <p>수령 조가 점수 교환 여부를 선택하는 중입니다.</p>}{reward.status === 'completed' && <p className="reward-result">{REWARDS[reward.reward_type] || '보상 완료'}{reward.reward_type === 'swap' ? (reward.swap_used ? ` · ${recipient}조 ↔ ${reward.swap_target_team}조 점수 교환 완료` : ' · 사용하지 않음') : ' · 반영 완료'}</p>}</>}</section>}
          {role === 'host' && game.phase === 'explanation' && <section className="card"><button disabled={busy || (reward.status !== 'not_registered' && reward.status !== 'completed')} onClick={() => hostAction('quiz_host_advance', { p_expected: game.current_question })}>{game.current_question === totalQuestions ? '🏁 최종 결과 보기' : '다음 문제 →'}</button>{reward.status !== 'not_registered' && reward.status !== 'completed' && <p className="muted">랜덤박스 처리가 끝나면 다음 문제로 이동할 수 있습니다.</p>}</section>}
        </>}
        {role === 'host' && game.phase !== 'finished' && <section className="admin-actions"><button className="secondary" disabled={busy} onClick={() => { if (window.confirm('정말 새 게임으로 초기화할까요? 모든 점수, 접속, 진행 기록이 삭제됩니다.')) hostAction('quiz_host_reset') }}>⚠️ 게임 전체 초기화</button></section>}
      </>}
    </>}
    <footer>승강기 안전관리법 학습용 조별 퀴즈 · 진행자 1명 / 참가 조 4개</footer>
  </main>
}
