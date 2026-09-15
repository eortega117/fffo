const SLEEPER_BASE = 'https://api.sleeper.app/v1';
const PLAYERS_CACHE_KEY = 'ffo_players_cache_v1';
const PLAYERS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
const SCORED_POSITIONS = ['QB', 'RB', 'WR', 'TE'];
const RECENT_FORM_WINDOW = 3;

// Weights (must sum to 0.925 — the remaining 7.5% is reserved for a future
// "rest of season rankings" component and isn't in the formula yet).
const WEIGHTS = {
  pointsFor: 25,
  record: 20,
  QB: 7.5,
  RB: 15,
  WR: 15,
  TE: 5,
  recentForm: 5,
};
const ACTIVE_WEIGHT_TOTAL = 92.5;

const form = document.getElementById('league-form');
const input = document.getElementById('league-id-input');
const submitBtn = document.getElementById('pr-submit');
const statusEl = document.getElementById('pr-status');
const panel = document.getElementById('pr-panel');
const results = document.getElementById('pr-results');
const leagueNameEl = document.getElementById('pr-league-name');
const leagueMetaEl = document.getElementById('pr-league-meta');
const tableBody = document.getElementById('pr-table-body');
const positionGrid = document.getElementById('pr-position-grid');
const changeLeagueBtn = document.getElementById('pr-change-league');

function setStatus(message, kind) {
  if (!message) {
    statusEl.hidden = true;
    statusEl.textContent = '';
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = message;
  statusEl.className = 'pr-status' + (kind ? ' pr-status--' + kind : '');
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 404) throw new Error('NOT_FOUND');
    throw new Error('HTTP_' + res.status);
  }
  return res.json();
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============ TEAM IDENTITY ============

function teamNameFor(roster, userById) {
  const user = roster.owner_id ? userById.get(roster.owner_id) : null;
  if (user && user.metadata && user.metadata.team_name) return user.metadata.team_name;
  if (user && user.display_name) return user.display_name;
  return 'Team ' + roster.roster_id + ' (unclaimed)';
}

function avatarUrlFor(roster, userById) {
  const user = roster.owner_id ? userById.get(roster.owner_id) : null;
  const avatarId = (user && user.metadata && user.metadata.avatar) || (user && user.avatar);
  return avatarId ? 'https://sleepercdn.com/avatars/thumbs/' + avatarId : null;
}

function buildTeams(rosters, users) {
  const userById = new Map(users.map(u => [u.user_id, u]));
  const teams = new Map();
  rosters.forEach(roster => {
    teams.set(roster.roster_id, {
      rosterId: roster.roster_id,
      teamName: teamNameFor(roster, userById),
      avatarUrl: avatarUrlFor(roster, userById),
      isUnclaimed: !roster.owner_id,
      // running totals filled in as we process weeks
      wins: 0, losses: 0, ties: 0,
      pointsFor: 0, pointsAgainst: 0,
      weeklyPoints: [], // [{week, points}]
      positionWeeklyTotals: { QB: [], RB: [], WR: [], TE: [] },
    });
  });
  return teams;
}

// ============ PLAYERS DICTIONARY (cached — ~5MB, refresh at most daily) ============

async function getPlayersMap() {
  try {
    const cached = localStorage.getItem(PLAYERS_CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Date.now() - parsed.fetchedAt < PLAYERS_CACHE_TTL_MS) {
        return parsed.players;
      }
    }
  } catch (e) {
    // corrupt cache entry — fall through and refetch
  }

  const players = await fetchJSON(`${SLEEPER_BASE}/players/nfl`);
  try {
    localStorage.setItem(PLAYERS_CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), players }));
  } catch (e) {
    // localStorage full/unavailable — fine, just won't cache
  }
  return players;
}

// ============ WEEKLY MATCHUP DATA ============
// Walk weeks starting at 1 until we hit one with no scoring yet (i.e. hasn't
// been played), rather than trusting a "current week" field — more robust
// across different league settings.

async function getPlayedWeeks(leagueId) {
  const weeks = [];
  for (let week = 1; week <= 18; week++) {
    const matchups = await fetchJSON(`${SLEEPER_BASE}/league/${leagueId}/matchups/${week}`);
    const hasScoring = matchups.length > 0 && matchups.some(m => (m.points || 0) > 0);
    if (!hasScoring) break;
    weeks.push({ week, matchups });
  }
  return weeks;
}

// ============ RECORD (incl. our own league-median game) ============

function applyWeekToRecords(teams, weekMatchups) {
  // Real head-to-head: group by matchup_id.
  const byMatchupId = new Map();
  weekMatchups.forEach(m => {
    if (!byMatchupId.has(m.matchup_id)) byMatchupId.set(m.matchup_id, []);
    byMatchupId.get(m.matchup_id).push(m);
  });
  byMatchupId.forEach(pair => {
    if (pair.length !== 2) return; // bye or malformed data — skip
    const [a, b] = pair;
    if (a.points > b.points) { bumpRecord(teams, a.roster_id, 'win'); bumpRecord(teams, b.roster_id, 'loss'); }
    else if (b.points > a.points) { bumpRecord(teams, b.roster_id, 'win'); bumpRecord(teams, a.roster_id, 'loss'); }
    else { bumpRecord(teams, a.roster_id, 'tie'); bumpRecord(teams, b.roster_id, 'tie'); }
  });

  // League-median game: top half of the week's scores (ties included) get a win.
  const sortedScores = weekMatchups.map(m => m.points).sort((x, y) => y - x);
  const n = sortedScores.length;
  const median = n % 2 === 0
    ? (sortedScores[n / 2 - 1] + sortedScores[n / 2]) / 2
    : sortedScores[(n - 1) / 2];
  weekMatchups.forEach(m => {
    bumpRecord(teams, m.roster_id, m.points >= median ? 'win' : 'loss');
  });

  // Points for/against + weekly total (for PF, recent form).
  byMatchupId.forEach(pair => {
    if (pair.length !== 2) return;
    const [a, b] = pair;
    addPoints(teams, a.roster_id, a.points, b.points);
    addPoints(teams, b.roster_id, b.points, a.points);
  });
}

function bumpRecord(teams, rosterId, result) {
  const team = teams.get(rosterId);
  if (!team) return;
  if (result === 'win') team.wins += 1;
  else if (result === 'loss') team.losses += 1;
  else team.ties += 1;
}

function addPoints(teams, rosterId, pf, pa) {
  const team = teams.get(rosterId);
  if (!team) return;
  team.pointsFor += pf;
  team.pointsAgainst += pa;
}

// ============ POSITION TOTALS (starters + bench) ============

function applyWeekToPositions(teams, weekMatchups, playersMap) {
  weekMatchups.forEach(m => {
    const team = teams.get(m.roster_id);
    if (!team) return;
    const weekTotals = { QB: 0, RB: 0, WR: 0, TE: 0 };
    (m.players || []).forEach(playerId => {
      const player = playersMap[playerId];
      const pos = player && player.position;
      if (!SCORED_POSITIONS.includes(pos)) return;
      const pts = (m.players_points && m.players_points[playerId]) || 0;
      weekTotals[pos] += pts;
    });
    SCORED_POSITIONS.forEach(pos => team.positionWeeklyTotals[pos].push(weekTotals[pos]));
    team.weeklyPoints.push(m.points || 0);
  });
}

// ============ SCORING ============

function average(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function computeScores(teams, weeksPlayed) {
  const teamList = [...teams.values()];
  const totalPossibleGames = 2 * weeksPlayed;

  const leaguePF = average(teamList.map(t => average(t.weeklyPoints)));
  const leaguePosAvg = {};
  SCORED_POSITIONS.forEach(pos => {
    leaguePosAvg[pos] = average(teamList.map(t => average(t.positionWeeklyTotals[pos])));
  });

  const recentWeekCount = Math.min(RECENT_FORM_WINDOW, weeksPlayed);
  const leagueRecentAvg = average(
    teamList.map(t => average(t.weeklyPoints.slice(-recentWeekCount)))
  );

  teamList.forEach(team => {
    const teamPF = average(team.weeklyPoints);
    const pfScore = leaguePF > 0 ? WEIGHTS.pointsFor * (teamPF / leaguePF) : 0;

    const recordScore = totalPossibleGames > 0
      ? WEIGHTS.record * (team.wins / totalPossibleGames)
      : 0;

    const positionScores = {};
    SCORED_POSITIONS.forEach(pos => {
      const teamAvg = average(team.positionWeeklyTotals[pos]);
      positionScores[pos] = leaguePosAvg[pos] > 0
        ? WEIGHTS[pos] * (teamAvg / leaguePosAvg[pos])
        : 0;
    });

    const teamRecentAvg = average(team.weeklyPoints.slice(-recentWeekCount));
    const recentFormScore = leagueRecentAvg > 0
      ? WEIGHTS.recentForm * (teamRecentAvg / leagueRecentAvg)
      : 0;

    const rawTotal = pfScore + recordScore + positionScores.QB + positionScores.RB
      + positionScores.WR + positionScores.TE + recentFormScore;

    team.score = rawTotal / (ACTIVE_WEIGHT_TOTAL / 100);
    team.breakdown = { pfScore, recordScore, positionScores, recentFormScore };
    team.positionAverages = {
      QB: average(team.positionWeeklyTotals.QB),
      RB: average(team.positionWeeklyTotals.RB),
      WR: average(team.positionWeeklyTotals.WR),
      TE: average(team.positionWeeklyTotals.TE),
    };
  });

  return teamList;
}

// ============ RENDER ============

function formatRecord(team) {
  return team.ties > 0
    ? `${team.wins}-${team.losses}-${team.ties}`
    : `${team.wins}-${team.losses}`;
}

function renderTeams(league, teamList) {
  leagueNameEl.textContent = league.name || 'League';
  const season = league.season ? `${league.season} season` : '';
  const size = `${teamList.length} teams`;
  leagueMetaEl.textContent = [season, size].filter(Boolean).join(' · ');

  const sorted = [...teamList].sort((a, b) => b.score - a.score);

  tableBody.innerHTML = sorted.map(team => `
    <tr>
      <td class="pr-team-cell">
        ${team.avatarUrl
          ? `<img class="pr-avatar" src="${team.avatarUrl}" alt="" />`
          : `<span class="pr-avatar pr-avatar--placeholder"></span>`}
        <span>${escapeHTML(team.teamName)}</span>
      </td>
      <td class="pr-score-cell">${team.score.toFixed(1)}</td>
      <td>${formatRecord(team)}</td>
      <td>${team.pointsFor.toFixed(1)}</td>
      <td>${team.pointsAgainst.toFixed(1)}</td>
    </tr>
  `).join('');

  renderPositionGrid(teamList);

  panel.hidden = true;
  results.hidden = false;
}

const POSITION_LABELS = { QB: 'Quarterbacks', RB: 'Running Backs', WR: 'Wide Receivers', TE: 'Tight Ends' };

function renderPositionGrid(teamList) {
  positionGrid.innerHTML = SCORED_POSITIONS.map(pos => {
    const sorted = [...teamList].sort((a, b) => b.positionAverages[pos] - a.positionAverages[pos]);
    const rows = sorted.map((team, i) => `
      <li>
        <span class="pr-pos-rank">${i + 1}</span>
        <span class="pr-pos-team">${escapeHTML(team.teamName)}</span>
        <span class="pr-pos-value">${team.positionAverages[pos].toFixed(1)}</span>
      </li>
    `).join('');
    return `
      <div class="pr-pos-card">
        <h3>${POSITION_LABELS[pos]}</h3>
        <p class="pr-pos-sub">Avg weekly points, starters + bench</p>
        <ol class="pr-pos-list">${rows}</ol>
      </div>
    `;
  }).join('');
}

// ============ MAIN FLOW ============

async function loadLeague(leagueId) {
  submitBtn.disabled = true;

  try {
    setStatus('Fetching your league from Sleeper…', 'loading');
    const [league, rosters, users] = await Promise.all([
      fetchJSON(`${SLEEPER_BASE}/league/${leagueId}`),
      fetchJSON(`${SLEEPER_BASE}/league/${leagueId}/rosters`),
      fetchJSON(`${SLEEPER_BASE}/league/${leagueId}/users`),
    ]);

    if (!rosters.length) {
      setStatus("Found the league, but it doesn't have any rosters yet.", 'error');
      submitBtn.disabled = false;
      return;
    }

    setStatus('Loading weekly scores…', 'loading');
    const playedWeeks = await getPlayedWeeks(leagueId);

    if (!playedWeeks.length) {
      setStatus("This league hasn't played any weeks yet, so there's nothing to rank.", 'error');
      submitBtn.disabled = false;
      return;
    }

    setStatus('Loading player data…', 'loading');
    const playersMap = await getPlayersMap();

    const teams = buildTeams(rosters, users);
    playedWeeks.forEach(({ matchups }) => {
      applyWeekToRecords(teams, matchups);
      applyWeekToPositions(teams, matchups, playersMap);
    });

    const teamList = computeScores(teams, playedWeeks.length);
    setStatus(null);
    renderTeams(league, teamList);
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      setStatus("Couldn't find a league with that ID — double check it and try again.", 'error');
    } else {
      setStatus('Something went wrong reaching Sleeper. Try again in a moment.', 'error');
    }
  } finally {
    submitBtn.disabled = false;
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const leagueId = input.value.trim();
  if (!leagueId) {
    setStatus('Enter a league ID first.', 'error');
    return;
  }
  loadLeague(leagueId);
});

changeLeagueBtn.addEventListener('click', () => {
  results.hidden = true;
  panel.hidden = false;
  setStatus(null);
});
