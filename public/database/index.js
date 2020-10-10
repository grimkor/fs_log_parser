const sqlite3 = require("sqlite3");
const fs = require("fs");
const path = require("path");
const { app } = require("electron");
app.getPath("home");

const createGameTable = `
create table IF NOT EXISTS game
(
    player_character TEXT,
    player_score     int,
    opp_character    TEXT,
    opp_score        int,
    match_id         int
        references match,
    constraint game_pk
        unique (player_character, opp_character, match_id)
);
`;

const createMatchTable = `
create table IF NOT EXISTS match
(
    match_id         TEXT not null
        constraint match_pk
            primary key,
    timestamp        INTEGER default CURRENT_TIMESTAMP,
    player_league    int,
    player_rank      int,
    player_stars     int,
    opp_id           int,
    opp_name         TEXT,
    opp_platform     TEXT,
    opp_platform_id  int,
    opp_input_config int,
    opp_league       int,
    opp_rank         int,
    match_type       TEXT
);
`;

const createConfigTable = `
create table IF NOT EXISTS config
(
    setting TEXT
        constraint config_pk
            primary key,
    value   TEXT
);

create unique index config_setting_uindex
    on config (setting);
`;

const getDatabase = () => {
  const newDb = !fs.existsSync(
    path.join(app.getPath("home"), "fs-log-parser.db")
  );
  const db = new sqlite3.Database(
    path.join(app.getPath("home"), "fs-log-parser.db"),
    (err) => {
      if (!err && newDb) {
        db.serialize(() => {
          db.run(createConfigTable);
          db.run(createMatchTable);
          db.run(createGameTable);
        });
      }
    }
  );
  return db;
};

const getColumns = (table, callback) => {
  const db = getDatabase();
  db.all(`pragma table_info(${table})`, (err, result) => {
    callback(err, result);
  });
};

const getConfig = (callback) => {
  const db = getDatabase();
  return db.all(`SELECT * from config`, callback);
};

const setConfig = (config, callback) => {
  const db = getDatabase();
  db.serialize(() => {
    const statement = db.prepare(`
    INSERT OR REPLACE INTO config 
    (setting, value) VALUES (?, ?)
    `);
    Object.entries(config).forEach(([key, value]) => statement.run(key, value));
    statement.finalize(callback);
  });
};

const insertMatch = (match, callback) => {
  const db = getDatabase();
  db.serialize(() => {
    db.run(
      `
    INSERT OR IGNORE INTO match
    (id, match_type, player_league, player_rank, player_stars, opp_id, opp_name, opp_platform, opp_platform_id, opp_input_config, opp_league, opp_rank)
    VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
      [
        match.matchId,
        match.matchType,
        match.playerLeague,
        match.playerRank,
        match.playerStars,
        match.oppId,
        match.oppName,
        match.oppPlatform,
        match.oppPlatformId,
        match.oppInputConfig,
        match.oppLeague,
        match.oppRank,
      ],
      callback
    );
  });
};

const insertGameResult = (game, callback) => {
  const db = getDatabase();
  db.serialize(() => {
    db.run(
      `
      INSERT OR IGNORE INTO match
      (id) VALUES (?)
    `,
      [game.id]
    );
    db.run(
      `
      INSERT INTO game
      (match_id, player_character, opp_character, player_score, opp_score)
      VALUES
      (?,?,?,?,?)
    `,
      [
        game.id,
        game.player_character,
        game.opp_character,
        game.player_score,
        game.opp_score,
      ],
      callback
    );
  });
};

const getWinLoss = (callback) => {
  const db = getDatabase();
  db.serialize(() => {
    db.all(
      `
        select count(id)                                              as total,
               sum(case when win > lose then 1 else 0 end)            as wins,
               sum(case when win < lose then 1 else 0 end)            as losses,
               sum(case when win > lose AND last30 then 1 else 0 end) as wins30,
               sum(case when win < lose AND last30 then 1 else 0 end) as losses30,
               MIN(x.player_rank)                                     as max_rank,
               (SELECT player_rank FROM match ORDER BY timestamp limit 1)      as rank,
               x.match_type
        from (
                 select m.id,
                        m.match_type,
                        player_rank,
                        timestamp,
                        sum(case when g.player_score > g.opp_score then 1 else 0 end)       as win,
                        sum(case when g.player_score < g.opp_score then 1 else 0 end)       as lose,
                        case when timestamp > datetime('now', '-30 days') then 1 else 0 end as last30
                 from match m
                          join game g on m.id = g.match_id
                 group by m.id, m.match_type
             ) x
        group by x.match_type;
    `,
      callback
    );
  });
};

module.exports = {
  getConfig,
  setConfig,
  insertGameResult,
  insertMatch,
  getWinLoss,
};
