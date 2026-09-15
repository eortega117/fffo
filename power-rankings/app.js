const SLEEPER_BASE = 'https://api.sleeper.app/v1';

const form = document.getElementById('league-form');
const input = document.getElementById('league-id-input');
const submitBtn = document.getElementById('pr-submit');
const statusEl = document.getElementById('pr-status');
const panel = document.getElementById('pr-panel');
const results = document.getElementById('pr-results');
const leagueNameEl = document.getElementById('pr-league-name');
const leagueMetaEl = document.getElementById('pr-league-meta');
const tableBody = document.getElementById('pr-table-body');
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
    if (res.status === 404) {
      throw new Error('NOT_FOUND');
    }
    throw new Error('HTTP_' + res.status);
  }
  return res.json();
}

function teamNameFor(roster, userById) {
  const user = roster.owner_id ? userById.get(roster.owner_id) : null;
  if (user && user.metadata && user.metadata.team_name) {
    return user.metadata.team_name;
  }
  if (user && user.display_name) {
    return user.display_name;
  }
  return 'Team ' + roster.roster_id + ' (unclaimed)';
}

function avatarUrlFor(roster, userById) {
  const user = roster.owner_id ? userById.get(roster.owner_id) : null;
  const avatarId = (user && user.metadata && user.metadata.avatar) || (user && user.avatar);
  return avatarId ? 'https://sleepercdn.com/avatars/thumbs/' + avatarId : null;
}

function buildTeams(league, rosters, users) {
  const userById = new Map(users.map(u => [u.user_id, u]));

  return rosters.map(roster => {
    const settings = roster.settings || {};
    const wins = settings.wins || 0;
    const losses = settings.losses || 0;
    const ties = settings.ties || 0;
    // Sleeper splits points into whole + decimal fields.
    const pf = (settings.fpts || 0) + (settings.fpts_decimal || 0) / 100;
    const pa = (settings.fpts_against || 0) + (settings.fpts_against_decimal || 0) / 100;

    return {
      rosterId: roster.roster_id,
      teamName: teamNameFor(roster, userById),
      avatarUrl: avatarUrlFor(roster, userById),
      isUnclaimed: !roster.owner_id,
      wins,
      losses,
      ties,
      pointsFor: pf,
      pointsAgainst: pa,
    };
  });
}

function formatRecord(team) {
  return team.ties > 0
    ? `${team.wins}-${team.losses}-${team.ties}`
    : `${team.wins}-${team.losses}`;
}

function renderTeams(league, teams) {
  leagueNameEl.textContent = league.name || 'League';
  const season = league.season ? `${league.season} season` : '';
  const size = `${teams.length} teams`;
  leagueMetaEl.textContent = [season, size].filter(Boolean).join(' · ');

  const sorted = [...teams].sort((a, b) => {
    const winPctA = a.wins / Math.max(1, a.wins + a.losses + a.ties);
    const winPctB = b.wins / Math.max(1, b.wins + b.losses + b.ties);
    if (winPctB !== winPctA) return winPctB - winPctA;
    return b.pointsFor - a.pointsFor;
  });

  tableBody.innerHTML = sorted.map(team => `
    <tr>
      <td class="pr-team-cell">
        ${team.avatarUrl
          ? `<img class="pr-avatar" src="${team.avatarUrl}" alt="" />`
          : `<span class="pr-avatar pr-avatar--placeholder"></span>`}
        <span>${escapeHTML(team.teamName)}</span>
      </td>
      <td>${formatRecord(team)}</td>
      <td>${team.pointsFor.toFixed(1)}</td>
      <td>${team.pointsAgainst.toFixed(1)}</td>
    </tr>
  `).join('');

  panel.hidden = true;
  results.hidden = false;
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function loadLeague(leagueId) {
  submitBtn.disabled = true;
  setStatus('Fetching your league from Sleeper…', 'loading');

  try {
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

    const teams = buildTeams(league, rosters, users);
    setStatus(null);
    renderTeams(league, teams);
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
