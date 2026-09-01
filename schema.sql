-- D1 schema for anonymous cup rankings (production + local)
CREATE TABLE IF NOT EXISTS song_wins (
  song_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT '',
  cover TEXT NOT NULL DEFAULT '',
  artist_id TEXT NOT NULL DEFAULT '',
  wins INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artist_wins (
  artist_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '',
  wins INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- 歌手大比拼（artist-cup）专属夺冠榜；与「歌曲夺冠所属歌手」的 artist_wins 分离
CREATE TABLE IF NOT EXISTS artist_pk_wins (
  artist_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '',
  wins INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vote_quota_daily (
  voter_key TEXT NOT NULL,
  quota_date TEXT NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (voter_key, quota_date)
);

-- Privacy-friendly product analytics: daily totals + anonymous daily uniques.
CREATE TABLE IF NOT EXISTS analytics_events_daily (
  event_date TEXT NOT NULL,
  event_name TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  unique_visitors INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (event_date, event_name)
);

CREATE TABLE IF NOT EXISTS analytics_event_uniques (
  event_date TEXT NOT NULL,
  event_name TEXT NOT NULL,
  visitor_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_date, event_name, visitor_key)
);

CREATE INDEX IF NOT EXISTS idx_song_wins ON song_wins (wins DESC);
CREATE INDEX IF NOT EXISTS idx_artist_wins ON artist_wins (wins DESC);
CREATE INDEX IF NOT EXISTS idx_artist_pk_wins ON artist_pk_wins (wins DESC);
CREATE INDEX IF NOT EXISTS idx_vote_quota_date ON vote_quota_daily (quota_date, used_count DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_date ON analytics_events_daily (event_date DESC, event_name);
CREATE INDEX IF NOT EXISTS idx_analytics_uniques_date ON analytics_event_uniques (event_date DESC);

-- 梦回大厂 · 神级舞台夺冠榜
CREATE TABLE IF NOT EXISTS stage_wins (
  stage_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT '',
  cover TEXT NOT NULL DEFAULT '',
  chapter TEXT NOT NULL DEFAULT '',
  wins INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stage_wins ON stage_wins (wins DESC);

-- Label beef (厂牌巅峰混战): one finished cup = 1 battle for both; champion gets 1 win.
CREATE TABLE IF NOT EXISTS label_beef_stats (
  label_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '',
  wins INTEGER NOT NULL DEFAULT 0,
  battles INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS label_beef_matchups (
  label_id TEXT NOT NULL,
  opponent_id TEXT NOT NULL,
  wins INTEGER NOT NULL DEFAULT 0,
  battles INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (label_id, opponent_id)
);

CREATE TABLE IF NOT EXISTS label_beef_champions (
  label_id TEXT NOT NULL,
  opponent_id TEXT NOT NULL,
  song_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  artist TEXT NOT NULL DEFAULT '',
  cover TEXT NOT NULL DEFAULT '',
  wins INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (label_id, opponent_id, song_id)
);

CREATE INDEX IF NOT EXISTS idx_label_beef_stats ON label_beef_stats (wins DESC, battles DESC);
CREATE INDEX IF NOT EXISTS idx_label_beef_matchups ON label_beef_matchups (label_id, battles DESC);
CREATE INDEX IF NOT EXISTS idx_label_beef_champions
  ON label_beef_champions (label_id, opponent_id, wins DESC);

-- 「从夯到拉」：获得「夯」/「拉完了」次数
CREATE TABLE IF NOT EXISTS hangla_artist_stats (
  artist_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '',
  hang_wins INTEGER NOT NULL DEFAULT 0,
  lale_wins INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hangla_hang ON hangla_artist_stats (hang_wins DESC, name ASC);
CREATE INDEX IF NOT EXISTS idx_hangla_lale ON hangla_artist_stats (lale_wins DESC, name ASC);

-- 「谁是单挑王」：歌手夺冠 + 必杀曲
CREATE TABLE IF NOT EXISTS duel_king_wins (
  artist_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '',
  wins INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS duel_king_songs (
  artist_id TEXT NOT NULL,
  song_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  cover TEXT NOT NULL DEFAULT '',
  wins INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (artist_id, song_id)
);

CREATE INDEX IF NOT EXISTS idx_duel_king_wins ON duel_king_wins (wins DESC);
CREATE INDEX IF NOT EXISTS idx_duel_king_songs ON duel_king_songs (artist_id, wins DESC);

-- 各玩法参与局数（夯拉历史无独立局数表，用本表累计；歌曲/厂牌/歌手PK可从业务表推算）
CREATE TABLE IF NOT EXISTS participation_stats (
  mode TEXT PRIMARY KEY,
  plays INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- 歌手近况热度：歌曲杯归属 + 歌手PK + 单挑王 的日增量（UTC+8）
CREATE TABLE IF NOT EXISTS artist_activity_daily (
  day TEXT NOT NULL,
  artist_id TEXT NOT NULL,
  name TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '',
  wins INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (day, artist_id)
);
CREATE INDEX IF NOT EXISTS idx_artist_activity_day ON artist_activity_daily (day, wins DESC);
