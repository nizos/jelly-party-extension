/* eslint-disable @typescript-eslint/no-explicit-any */
import { difference as _difference } from "lodash-es";
import log from "loglevel";
import generateRoomWithoutSeparator from "./randomName.js";
// @ts-ignore
import toHHMMSS from "./toHHMMSS.js";
import "./libs/css/notyf.min.css";
import { Peer as PeerType, ChatMessage } from "@/store/party/types";
import store from "@/store/store";
import { RootState as RootStateType } from "@/store/types";
import { OptionsState as OptionsStateType } from "@/store/options/types";
import { PartyState as PartyStateType } from "@/store/party/types";
import { state as optionsState } from "@/store/options/index";
import { state as partyState } from "@/store/party/index";
import { stableWebsites } from "@/helpers/stableWebsites";
import { IFrameMessenger, DataFrame } from "@/browser/Messenger";
import { DataFrameType, DataFrameMediaVariantType } from "@/browser/Messenger";
import { VideoState } from "./videoHandler.js";

export default class JellyParty {
  // Root State
  readonly rootState: RootStateType;
  // Options State
  readonly optionsState: OptionsStateType;
  // Party State
  readonly partyState: PartyStateType;
  // Local state
  partyIdFromURL: string | null;
  magicLinkUsed: boolean;
  updateClientStateInterval: number | undefined;
  ws!: WebSocket & { uuid?: string };
  notyf: any;
  stableWebsite!: boolean;
  iFrameMessenger: IFrameMessenger;
  videoState!: VideoState;
  resolveVideoState!: (arg0: VideoState) => VideoState;

  constructor() {
    this.rootState = store.state;
    this.optionsState = optionsState;
    this.partyState = partyState;
    this.magicLinkUsed = false;
    for (const stableWebsite of stableWebsites) {
      if (window.location.href.includes(stableWebsite)) {
        this.stableWebsite = true;
      }
    }
    this.partyIdFromURL = new URLSearchParams(window.location.search).get(
      "jellyPartyId"
    );
    if (this.partyIdFromURL) {
      log.debug(`partyIdFromURL is ${this.partyIdFromURL}`);
    }
    this.updateClientStateInterval = undefined;
    if (["staging", "development"].includes(this.rootState.appMode)) {
      log.enableAll();
    } else {
      log.setDefaultLevel("info");
    }
    log.info(
      `Jelly-Party: Debug logging is ${
        ["staging", "development"].includes(this.rootState.appMode)
          ? "enabled"
          : "disabled"
      }.`
    );
    if (this.partyIdFromURL && !this.magicLinkUsed) {
      log.debug("Joining party once via magic link.");
      this.magicLinkUsed = true;
      this.joinParty(this.partyIdFromURL);
    }
    this.iFrameMessenger = new IFrameMessenger(this);
    log.debug("Jelly-Party: Global JellyParty Object");
    log.debug(this);
  }
  resetPartyState() {
    store.dispatch("party/resetPartyState");
  }

  updateMagicLink() {
    // Get "clean" website URL without jellyPartyId=..
    const searchParams = new URLSearchParams(window.location.search);
    searchParams.delete("jellyPartyId");
    const redirectURL = encodeURIComponent(
      window.location.origin + window.location.pathname + "?" + searchParams
    );
    // Set the magic link
    const magicLink = `https://join.jelly-party.com/?jellyPartyId=${this.partyState.partyId}&redirectURL=${redirectURL}`;
    store.dispatch("party/setMagicLink", magicLink);
  }

  updateClientState = async function(this: JellyParty) {
    // Request a client state update
    // without "bind", "this" is bound to window, see 'The "this" problem' @ https://developer.mozilla.org/en-US/docs/Web/API/WindowOrWorkerGlobalScope/setInterval
    try {
      // We craft a command to let the server know about our new client state
      const serverCommand = {
        type: "clientUpdate",
        data: {
          newClientState: {
            currentlyWatching: this.partyState.magicLink,
            videoState: await this.getVideoState(),
          },
        },
      };
      this.ws.send(JSON.stringify(serverCommand));
    } catch (error) {
      log.debug("Jelly-Party: Error updating client state..");
      log.error(error);
    }
  }.bind(this);

  startParty() {
    this.connectToPartyHelper();
  }

  joinParty(partyId: string) {
    this.connectToPartyHelper(partyId);
  }

  displayNotification(notificationText: string) {
    const notyfDataFrame = {
      type: "notyf" as "notyf",
      payload: {
        type: "notification" as "notification",
        message: notificationText,
      },
    };
    this.iFrameMessenger.sendData(notyfDataFrame);
  }

  connectToPartyHelper = function(this: JellyParty, partyId = "") {
    // Start a new party if no partyId is given, else join an existing party
    const start = partyId ? false : true;
    log.info(
      `Jelly-Party: ${start ? "Starting a new party." : "Joining a new party."}`
    );
    if (this.partyState.isActive) {
      log.error(
        `Jelly-Party: Error. Cannot ${
          start ? "start" : "join"
        } a party while still in an active party.`
      );
      return;
    }
    // this.admin = Boolean(start);
    store.dispatch("party/setActive", true);
    store.dispatch(
      "party/setPartyId",
      start ? generateRoomWithoutSeparator() : partyId
    );
    // Set the magic link
    this.updateMagicLink();
    let wsAddress = "";
    log.log(`APPMODE IS: ${this.rootState.appMode}`);
    switch (this.rootState.appMode) {
      case "staging":
        wsAddress = "wss://staging.jelly-party.com:8080";
        break;
      default:
        wsAddress = "wss://ws.jelly-party.com:8080";
    }
    log.debug(`Jelly-Party: Connecting to ${wsAddress}`);
    this.ws = new WebSocket(wsAddress);
    store.dispatch("setConnectingToServer", true);
    this.ws.onopen = function(this: JellyParty) {
      store.dispatch("setConnectingToServer", false);
      store.dispatch("setConnectedToServer", true);
      log.debug("Jelly-Party: Connected to Jelly-Party Websocket.");
      this.displayNotification("Connected to server!");
      // this.lastPartyId = this.partyId;
      // log.debug(`Jelly-Party: Last Party Id set to ${this.optionsState.lastPartyId}`);

      this.ws.send(
        JSON.stringify({
          type: "join",
          data: {
            guid: this.optionsState.guid,
            partyId: this.partyState.partyId,
            clientState: {
              clientName: this.optionsState.clientName,
              currentlyWatching: this.partyState.magicLink,
              videoState: {},
              avatarState: this.optionsState.avatarState,
            },
          },
        })
      );
      this.updateClientStateInterval = setInterval(
        this.updateClientState,
        5000
      );
    }.bind(this);

    this.ws.onmessage = function(this: JellyParty, event: any) {
      const msg = JSON.parse(event.data);
      switch (msg.type) {
        case "videoUpdate": {
          // Find out which peer caused the event
          const peer = this.partyState.peers.filter(
            (peer) => peer.uuid === msg.data.peer.uuid
          )[0].clientName;
          const mediaDataFrame = {
            type: "media" as DataFrameType,
            payload: {
              type: "videoUpdate" as "videoUpdate",
              data: {
                variant: msg.data.variant as DataFrameMediaVariantType,
                tick: msg.data.tick,
              },
            },
          };
          this.iFrameMessenger.sendData(mediaDataFrame);
          const notificationText =
            msg.data.variant === "play"
              ? `${peer} played the video.`
              : msg.data.variant === "pause"
              ? `${peer} paused the video.`
              : `${peer} jumped to ${toHHMMSS(msg.data.tick)}.`;
          this.displayNotification(notificationText);
          break;
        }
        case "partyStateUpdate": {
          if (this.partyState.peers.length > msg.data.partyState.peers.length) {
            // Somebody left the party; Let's find out who
            const previousUUIDs = this.partyState.peers.map(
              (peer) => peer.uuid
            );
            const newUUIDs = msg.data.partyState.peers.map(
              (peer: PeerType) => peer.uuid
            );
            const peerWhoLeft = this.partyState.peers.filter(
              (peer: PeerType) =>
                peer.uuid === _difference(previousUUIDs, newUUIDs)[0]
            )[0];
            if (peerWhoLeft) {
              this.displayNotification(
                `${peerWhoLeft.clientName} left the party.`
              );
            }
          } else if (
            this.partyState.peers.length < msg.data.partyState.peers.length
          ) {
            // Somebody joined the party
            const previousUUIDs = this.partyState.peers.map(
              (peer: PeerType) => peer.uuid
            );
            const newUUIDs = msg.data.partyState.peers.map(
              (peer: PeerType) => peer.uuid
            );
            if (previousUUIDs.length === 0) {
              // Let's show all peers in the party
              for (const peer of msg.data.partyState.peers) {
                this.displayNotification(
                  `${peer.clientName} joined the party.`
                );
              }
            } else {
              // Show only the peer that joined
              const peerWhoJoined = msg.data.partyState.peers.filter(
                (peer: PeerType) =>
                  peer.uuid === _difference(newUUIDs, previousUUIDs)[0]
              )[0];
              if (peerWhoJoined) {
                this.displayNotification(
                  `${peerWhoJoined.clientName} joined the party.`
                );
              }
            }
          }
          store.dispatch("party/updatePartyState", msg.data.partyState);
          break;
        }
        case "chatMessage": {
          // this.chatHandler.chatComponent.receiveChatMessage(msg);
          break;
        }
        case "setUUID": {
          store.commit("party/setSelfUUID", msg.data.uuid);
          break;
        }
        default: {
          log.debug(
            `Jelly-Party: Received unknown message: ${JSON.stringify(msg)}`
          );
        }
      }
    }.bind(this);

    this.ws.onclose = function(this: JellyParty) {
      log.debug("Jelly-Party: Disconnected from WebSocket-Server.");
      clearInterval(this.updateClientStateInterval);
      store.dispatch("setConnectedToServer", false);
    }.bind(this);
  }.bind(this);

  leaveParty() {
    log.info("Jelly-Party: Leaving current party.");
    this.ws.close();
    this.resetPartyState();
    this.displayNotification("You left the party!");
  }

  sendChatMessage(text: string) {
    if (text.length > 0) {
      const chatMessage: ChatMessage = {
        type: "chatMessage",
        // peer: { uuid: partyState.selfUUID }, // will be added by server
        data: {
          text: text,
          timestamp: Date.now(),
        },
      };
      const serverCommand = {
        type: "forward",
        data: {
          commandToForward: chatMessage,
        },
      };
      this.ws.send(JSON.stringify(serverCommand));
      store.commit("party/addChatMessage", {
        peer: { uuid: partyState.selfUUID }, // for ourself, we must add the UUID
        ...chatMessage,
      });
    } else {
      log.log(`Jelly-Party: Not sending empty chat message.`);
    }
  }

  requestPeersToPlay(tick: number | undefined) {
    if (tick) {
      if (this.partyState.isActive) {
        const clientCommand = {
          type: "videoUpdate",
          data: {
            variant: "play",
            tick: tick,
            peer: { uuid: partyState.selfUUID },
          },
        };
        const serverCommand = {
          type: "forward",
          data: { commandToForward: clientCommand },
        };
        this.ws.send(JSON.stringify(serverCommand));
      }
    } else {
      log.log(`Jelly-Party: Invalid tick of ${tick}`);
    }
  }

  requestPeersToPause(tick: number | undefined) {
    if (tick) {
      if (this.partyState.isActive) {
        const clientCommand = {
          type: "videoUpdate",
          data: {
            variant: "pause",
            tick: tick,
            peer: { uuid: partyState.selfUUID },
          },
        };
        const serverCommand = {
          type: "forward",
          data: { commandToForward: clientCommand },
        };
        this.ws.send(JSON.stringify(serverCommand));
      }
    } else {
      log.log(`Jelly-Party: Invalid tick of ${tick}`);
    }
  }

  requestPeersToSeek(tick: number | undefined) {
    if (tick) {
      if (this.partyState.isActive) {
        const clientCommand = {
          type: "videoUpdate",
          data: {
            variant: "seek",
            tick: tick,
            peer: { uuid: partyState.selfUUID },
          },
        };
        const serverCommand = {
          type: "forward",
          data: { commandToForward: clientCommand },
        };
        this.ws.send(JSON.stringify(serverCommand));
      }
    } else {
      log.log(`Jelly-Party: Invalid tick of ${tick}`);
    }
  }

  async playVideo(tick: number) {
    // if (!this.videoHandler.getVideoState()) {
    //   log.warn(
    //     "Jelly-Party: No video defined. I shouldn't be receiving commands.."
    //   );
    // } else {
    //   // If we're already playing, ignore playVideo request
    //   if (!this.videoHandler.getVideoState()?.paused) {
    //     return;
    //   }
    //   // At the least, disable forwarding for the play event.
    //   // The seek event will handle itself.
    //   await this.seek(tick);
    //   this.videoHandler.eventsToProcess += 1;
    //   await this.videoHandler.play();
    // }
  }

  async pauseVideo(tick: number) {
    // if (!this.videoHandler.getVideoState()) {
    //   log.warn(
    //     "Jelly-Party: No video defined. I shouldn't be receiving commands.."
    //   );
    // } else {
    //   // If we're already paused, ignore pauseVideo request
    //   if (this.videoHandler.getVideoState()?.paused) {
    //     return;
    //   }
    //   // At the least, disable forwarding for the pause event.
    //   // The seek event will handle itself.
    //   await this.seek(tick);
    //   this.videoHandler.eventsToProcess += 1;
    //   await this.videoHandler.pause();
    // }
  }

  async seek(tick: number) {
    // const videoState = this.videoHandler.getVideoState();
    // if (!videoState?.currentTime || !videoState?.paused) {
    //   log.warn(
    //     "Jelly-Party: No video defined. I shouldn't be receiving commands.."
    //   );
    // } else {
    //   const timeDelta = Math.abs(tick - videoState?.currentTime);
    //   if (timeDelta > 0.5) {
    //     // Seeking is actually worth it. We're off by more than half a second.
    //     // Disable forwarding for the upcoming seek event.
    //     this.videoHandler.eventsToProcess += 1;
    //     await this.videoHandler.seek(tick);
    //   } else {
    //     log.debug(
    //       "Jelly-Party: Not actually seeking. Almost at same time already."
    //     );
    //   }
    // }
  }
  async getVideoState() {
    const dataframe: DataFrame = {
      type: "videoStateRequest",
      payload: {},
    };
    this.iFrameMessenger.sendData(dataframe);
    // We must await the asynchronous response. We do this by exposing the resolve method
    // to the JellyParty object, so that the Messenger (which has access to JellyParty)
    // can call resolve, once it has received the response
    return new Promise((resolve, reject) => {
      this.resolveVideoState = resolve as (arg0: VideoState) => VideoState;
    });
  }
}