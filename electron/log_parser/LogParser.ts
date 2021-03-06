import { ChildProcess } from "child_process";
import { Tail } from "tail";
import {
  authenticated,
  casualMatchFound,
  challengeMatchFound,
  friendTeamBattle,
  friendVersus,
  gameResult,
  rankedBotMatchFound,
  rankedData,
  rankedMatchFound,
} from "./matchers";
import db from "../database";
import { CasualMatchResult, RankedMatchResult } from "../types";
import Logger from "../logger";

const { MatchType } = require("../../common/constants");
const { IpcActions } = require("../../common/constants");

class LogParser {
  process: ChildProcess;
  file: string;
  tail: Tail;
  // @ts-ignore
  player: {
    name: string;
    league: string;
    rank: string;
    stars: string;
  };
  // @ts-ignore
  opponent: {
    id: string;
    name: string;
    league: string;
    rank: string;
  };
  // @ts-ignore
  matchId: string | null;
  matchType: typeof MatchType;
  challengeTeamBattle: boolean;
  matchMetaData: CasualMatchResult | RankedMatchResult | undefined;
  logger: Logger;

  constructor(file: string, process: ChildProcess) {
    this.process = process;
    this.file = file;
    this.challengeTeamBattle = false;
    this.setDefaultState();
    this.logger = new Logger();
    this.tail = new Tail(this.file, {
      useWatchFile: true,
    });
    this.tail.on("line", this.processLine.bind(this));
    this.tail.on("error", (error) =>
      this.logger.writeError("LogParser Tail", error)
    );

    db.getConfig((result) => {
      if (result?.find((x) => x.setting === "playerName")) {
        this.player.name =
          result.find((x) => x.setting === "playerName")?.value ?? "";
      }
    });
  }

  run() {
    this.tail.watch();
  }

  stop() {
    this.tail.unwatch();
  }

  setDefaultState() {
    this.player = {
      ...this.player,
      league: "",
      rank: "",
      stars: "0",
    };
    this.opponent = {
      id: "-1",
      name: "",
      league: "",
      rank: "",
    };
    this.matchId = null;
    this.matchType = MatchType.casual;
  }

  processLine(line: string) {
    try {
      const playerName = authenticated(line);
      if (playerName) {
        if (playerName && this.player.name !== playerName) {
          this.player.name = playerName;
          db.setPlayer({ name: this.player.name });
        }
        this.process.send([IpcActions.update, this.player.name]);
      }
      const casualMatch = casualMatchFound(line);
      const challengeMatch = challengeMatchFound(line);
      if (casualMatch || challengeMatch) {
        this.setDefaultState();
        const metaData = (casualMatch ?? challengeMatch) as CasualMatchResult;
        this.matchType = casualMatch ? MatchType.casual : MatchType.challenge;
        this.opponent.name = metaData.oppName.replace("*", "");
        this.opponent.id = metaData.oppPlayerId;
        this.matchMetaData = metaData;
      }
      const rankedMatchMetadata = rankedMatchFound(line);
      if (rankedMatchMetadata) {
        this.setDefaultState();
        this.opponent.id = rankedMatchMetadata.oppPlayerId;
        this.opponent.name = rankedMatchMetadata.oppName.replace("*", "");
        this.opponent.rank = rankedMatchMetadata.oppRank;
        this.opponent.league = rankedMatchMetadata.oppLeague;
        this.player.rank = rankedMatchMetadata.playerRank;
        this.player.league = rankedMatchMetadata.playerLeague;
        this.player.stars = rankedMatchMetadata.playerStars;
        this.matchMetaData = rankedMatchMetadata;
        this.matchType = MatchType.ranked;
      }
      const rankedBotMatchData = rankedBotMatchFound(line);
      if (rankedBotMatchData) {
        this.matchType = MatchType.bot_ranked;
      }

      const game = gameResult(line);
      if (game && this.matchType !== MatchType.bot_ranked) {
        let playerWins: boolean;
        const players = [game.loser.player, game.winner.player];
        if (this.opponent.name && players.includes(this.opponent.name)) {
          playerWins = game.winner.player !== this.opponent.name;
        } else if (this.player.name && players.includes(this.player.name)) {
          playerWins = game.winner.player === this.player.name;
        } else {
          return;
        }
        const player = playerWins ? game.winner : game.loser;
        const opponent = playerWins ? game.loser : game.winner;
        if (
          this.matchId !== null &&
          (this.matchType === MatchType.ranked ||
            (this.matchType === MatchType.challenge &&
              this.challengeTeamBattle))
        ) {
          db.insertGameResult(
            {
              match: this.matchMetaData,
              match_id: this.matchId,
              player_character: player.character,
              opp_character: opponent.character,
              player_score: String(player.score),
              opp_score: String(opponent.score),
            },
            () => {
              this.process.send([
                IpcActions.update,
                {
                  id: this.matchId,
                  player_character: player.character,
                  opp_character: opponent.character,
                  player_score: player.score,
                  opp_score: opponent.score,
                },
              ]);
            }
          );
        } else {
          db.insertMatch(
            {
              matchId: this.matchMetaData?.gameplayRandomSeed ?? "",
              matchType: this.matchType,
              playerLeague: this.player.league,
              playerRank: this.player.rank,
              playerStars: this.player.stars,
              oppId: this.opponent.id,
              oppName: this.opponent.name,
              oppPlatform: this.matchMetaData?.oppPlatform ?? "",
              oppPlatformId: this.matchMetaData?.oppPlatformId ?? "",
              oppInputConfig: this.matchMetaData?.oppInputConfig ?? "",
              oppLeague: this.opponent.league,
              oppRank: this.opponent.rank,
            },
            (data) => {
              if (data) {
                this.matchId = data.id;
                db.insertGameResult(
                  {
                    match: this.matchMetaData,
                    match_id: this.matchId,
                    player_character: player.character,
                    opp_character: opponent.character,
                    player_score: String(player.score),
                    opp_score: String(opponent.score),
                  },
                  () => {
                    this.process.send([
                      IpcActions.update,
                      {
                        id: this.matchId,
                        player_character: player.character,
                        opp_character: opponent.character,
                        player_score: player.score,
                        opp_score: opponent.score,
                      },
                    ]);
                  }
                );
              }
            }
          );
        }
      }

      const rank = rankedData(line);
      if (rank) {
        db.setPlayer(rank);
        this.process.send([IpcActions.update, rank]);
      }

      const isFriendTeamBattle = friendTeamBattle(line);
      if (isFriendTeamBattle) {
        this.challengeTeamBattle = true;
      }

      const isFriendVersus = friendVersus(line);
      if (isFriendVersus) {
        this.challengeTeamBattle = false;
      }
    } catch (e) {
      this.logger.writeError("LogParser", e);
    }
  }
}

export default LogParser;
