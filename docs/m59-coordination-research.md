# M59 coordination research

Raw findings from a fan-out of research agents over `C:\code\meridian59`, kept
because the run was cut short by a usage limit and this is what survived. Every claim
cites the file and line that enforces it. Treat a wire format as PROVISIONAL unless it
appears in the verification table at the bottom — a plausible-but-wrong format
desynchronises a packed stream silently.

What is already implemented from this: **trading** (`tools/m59-broker.mjs` `trade`),
and the object-flag affordances. What is not: selling to merchants, corpse looting,
reagents, guild operations.

**A caution about the verification table.** Several formats are marked `wrong` —
`BP_CREATE`, `BP_MOVE`, `BP_MESSAGE`. Those are verdicts on what a *research agent*
wrote here, not on `tools/m59-parse.mjs`. Those three were ported earlier and
directly from the C client's own handlers, and they are checked by the end-of-payload
invariant across 167 rooms and 1640 objects with zero failures — which is a stronger
test than a second reading of the source. Where this document and the code disagree
about a message the code already parses, **the code is the one that has been run.**
The value here is the subsystems the code does *not* yet cover.


---

## Player-to-player trading (offer / counteroffer / accept), Meridian 59

Trading is a single-slot, per-player state machine held in three User properties: poOffer_who (the other party), plOffer_items (what *I* have on the table), and pbOffer_OtherAccepted (permission to finalize) — declared at kod/object/active/holder/nomoveon/battler/player/user.kod:321-323. Exactly one offer per player at a time; both sides' poOffer_who must be $ to start. The offerer sends BP_REQ_OFFER(120) with a target id and an object list; the server echoes BP_OFFERED(213) to the offerer and pushes BP_OFFER(211) (offerer object + item list) to the target. The target then sends BP_REQ_COUNTEROFFER(123) — possibly with a ZERO-length list, which is how a pure gift is expressed — receiving BP_COUNTEROFFERED(215) as an echo while the offerer receives BP_COUNTEROFFER(214) and, crucially, gets pbOffer_OtherAccepted=TRUE. Only a party whose pbOffer_OtherAccepted is TRUE may send BP_ACCEPT_OFFER(121); doing so without it logs "ALERT!" and cancels the whole trade (user.kod:5518-5525). So there is exactly ONE accept in a normal trade, and it comes from whoever last received a counteroffer — the protocol is symmetric even though the stock client only ever lets the original offerer accept. On success items are shuttled through the two global singletons SystemHolder1/SystemHolder2 (user.kod:5545-5551, 5595-5620); the non-accepting side gets BP_OFFER_CANCELED(212) to dismiss its dialog, the accepting side gets NOTHING and must infer success from BP_INVENTORY_ADD(209)/BP_INVENTORY_REMOVE(210). BP_REQ_GIVE(114) and BP_REQ_TAKE(115) are pure vestigial enum values — they appear in include/proto.h:122-123 and kod/include/protocol.khd:68-69 and nowhere else in the tree; there is no sprocket table entry, no kod dispatch arm, and no client sender.

### Wire formats

**BP_REQ_OFFER (120) — client->server**

```
1 byte opcode(120) | 4 bytes targetPlayerId (top nibble MUST be 0 — the stock client masks it with GetObjId) | 2 bytes itemCount | itemCount x { 4 bytes objectId; if (objectId >> 28) == 1 (CLIENT_TAG_NUMBER) then 4 more bytes = signed int quantity }
```

*blakserv/sprocket.c:48 ({4,TAG_OBJECT},{2,LIST_OBJ_PARM}); clientd3d/protocol.c:50 (PARAM_ID, PARAM_OBJECT_LIST); clientd3d/protocol.c:210-214 (PARAM_ID -> GetObjId strips tag, SIZE_ID=4); clientd3d/protocol.c:262-289 (PARAM_OBJECT_LIST writes 2-byte count then id [+4-byte temp_amount if IsNumberObj]); blakserv/parsecli.c:265-315 (server reads 2-byte count, then per element 4 bytes, and 4 MORE bytes only when in_val.v.tag == CLIENT_TAG_NUMBER)*

VARIABLE STRIDE per list element: 4 bytes normally, 8 bytes for a tagged NumberItem/Money stack. This is the only place money enters an offer. clientd3d/protocol.c:275-276 and 284-285 silently DROP any tagged element whose amount <= 0, so the count written can be smaller than the caller's list length. On the server side the object list arrives in kod in REVERSE wire order (parsecli.c:298-300 Cons), and the separate #number_list is built with the same Cons so the two stay aligned (parsecli.c:308-311). An empty list is legal: count 0, no bytes after. parsecli.c:270-272 sets found_number_stuff=true for ANY LIST_OBJ_PARM, so #number_stuff is always passed (NIL when no tagged items).

**BP_ACCEPT_OFFER (121) — client->server**

```
1 byte opcode(121). No payload.
```

*blakserv/sprocket.c:52 ({0,DONE_PARM}); clientd3d/protocol.h:93 (SendAcceptOffer); kod .../player/user.kod:1157-1161*

Not gated by the anti-spam throttle (unlike BP_REQ_OFFER).

**BP_CANCEL_OFFER (122) — client->server**

```
1 byte opcode(122). No payload.
```

*blakserv/sprocket.c:50; clientd3d/protocol.h:92; kod .../player/user.kod:1141-1146*

Cancels from either side at any point. Not throttled.

**BP_REQ_COUNTEROFFER (123) — client->server**

```
1 byte opcode(123) | 2 bytes itemCount | itemCount x { 4 bytes objectId; if top nibble == 1 then 4 more bytes = quantity }
```

*blakserv/sprocket.c:51 ({2,LIST_OBJ_PARM}); clientd3d/protocol.c:54; clientd3d/protocol.h:94; kod .../player/user.kod:1148-1155*

Same variable-stride list as BP_REQ_OFFER. itemCount = 0 is legal and is the normal way the stock client says 'I accept your gift, I offer nothing' (clientd3d/offer.c:257-266: IDOK sends RequestCounteroffer(send_items) with send_items still NULL). Not throttled.

**BP_OFFER (211) — server->client**

```
1 byte opcode(211) | object <the offerer, a User> | 2 bytes itemCount | itemCount x object
```

*kod .../player/user.kod:5197-5206 (AddPacket(1,BP_OFFER); ToCliObject(what); AddPacket(2,Length(item_list)); loop ToCliObject); clientd3d/server.c:1028-1045 (ExtractObject(&ptr,&offerer) with includeLight defaulting true, then ExtractObjectList)*

Sent ONLY to the target of an offer. 'object' is the standard packed object: id(4) [amount(4) if top nibble==1] iconRsc(4) nameRsc(4) flags(4) rarity(4) dLighting paletteTranslation animation overlays — produced by ToCliObject at user.kod:2331-2465 (AddPacket(NUMBER_OBJECT,...) at 2341 for NumberItems, AddPacket(4,what) at 2345 otherwise; AddPacket(4,rarity) at 2435; SendLightingInformation at 2438; SendAnimation/SendOverlays at 2453-2454). The offerer object is a Player so its flags contain USER_YES|OFFER_YES|BATTLER_YES plus karma/guild/drawfx bits (user.kod:7302-7374) and its dLighting is the equipped-light block (player.kod:12450). ExtractObjectList (server.c:414-437) requires the list to consume EXACTLY the remaining bytes or the whole message is rejected — no partial parse.

**BP_OFFER_CANCELED (212) — server->client**

```
1 byte opcode(212). Zero payload.
```

*kod .../player/user.kod:5258 (OfferCanceled), 5269 (CancelIfOffer), 5356 (failed CounterOffer), 5650 (AcceptOffer success); clientd3d/server.c:1048-1054 (rejects if len != 0)*

Overloaded: means 'trade is over' for cancel, for every mid-flight validation failure that goes through CancelIfOffer, AND for successful completion on the NON-accepting side (user.kod:5649-5651 comment 'Send a "cancelled" to make dialog go away'). It is NOT sent to the accepting side on success. Not gated on pbLogged_on in CancelIfOffer (5269) but is in OfferCanceled (5256-5260).

**BP_OFFERED (213) — server->client**

```
1 byte opcode(213) | 2 bytes itemCount | itemCount x object
```

*kod .../player/user.kod:4993-4999; clientd3d/server.c:1057-1065*

Echo back to the OFFERER of what the server actually accepted as their side of the table (post-clamping). The NumberItem entries here are FRESH temporary objects created at user.kod:4975-4976, not the offerer's real stacks, so their ids differ from the inventory ids the client sent. Order equals wire order of the request (Cons over the already-reversed item_list at 4977/4982 re-reverses it). This message carries no recipient name — the stock client relies on a static struct filled in before the request (clientd3d/gameuser.c:472-480, 599-606). Arrival of BP_OFFERED is the only positive confirmation that BP_REQ_OFFER succeeded.

**BP_COUNTEROFFER (214) — server->client**

```
1 byte opcode(214) | 2 bytes itemCount | itemCount x object
```

*kod .../player/user.kod:5374-5379 (CounterOffer); clientd3d/server.c:1079-1092*

Sent to the party that did NOT counteroffer. RECEIVING THIS IS THE PERMISSION TO ACCEPT: the same method sets pbOffer_OtherAccepted = TRUE at user.kod:5382. itemCount may be 0 (the other side offers nothing back). The stock client keeps its Accept button greyed until this arrives (clientd3d/offer.c:66-67, 99-107).

**BP_COUNTEROFFERED (215) — server->client**

```
1 byte opcode(215) | 2 bytes itemCount | itemCount x object
```

*kod .../player/user.kod:5345-5351; clientd3d/server.c:1068-1076*

Echo to the party that just sent BP_REQ_COUNTEROFFER, showing the server's canonical version of their side (with fresh temporary NumberItem objects created at 5333). Sent BEFORE the other side's CounterOffer is invoked, so if that fails you receive BP_COUNTEROFFERED immediately followed by BP_OFFER_CANCELED (5352-5357).

**BP_REQ_DEPOSIT (230) — client->server**

```
1 byte opcode(230) | 4 bytes npcId | 2 bytes itemCount | itemCount x { id(4) [amount(4) if tagged] }  — byte-identical shape to BP_REQ_OFFER
```

*blakserv/sprocket.c:49; include/proto.h:208; kod .../player/user.kod:1213-1221, UserDeposit at 5006-5085*

Included because it drives the SAME poOffer_who / plOffer_items / BP_OFFERED state machine against NPCs (vaultman, or banker with exactly one Money item — user.kod:5035-5043), and therefore BLOCKS a player-to-player trade while pending. Not the p2p path, but it shares the single slot.

**BP_MESSAGE (202) — server->client**

```
1 byte opcode | 4 bytes messageResourceId | 0..8 optional parms, each 4 bytes by default (or a length-prefixed string when type=STRING_RESOURCE), present only if non-$
```

*kod .../player/user.kod:3207-3262; include/proto.h (BP_MESSAGE)*

This is how nearly every trade refusal reaches the client. Number of trailing parms is NOT transmitted — it is implied by the resource's format string, so parsing requires a resource-id -> arity map. See the 'rules' list for which resource each refusal uses.

**BP_SYS_MESSAGE (203) — server->client**

```
1 byte opcode | 4 bytes messageResourceId | 0..8 optional 4-byte parms, present only if non-$
```

*kod .../player/user.kod:3265-3300*

Used for the incoming-offer notice user_got_offer ('You have a trade offer from %s%s.') at user.kod:5194-5196, sent just before BP_OFFER.

### Rules, in the order the server checks them

| | rule | where |
|---|---|---|
| **silent** | BP_REQ_OFFER is dropped entirely if the sender exceeded the packet throttle (more than INCOMING_PACKET_THROTTLE=5 client packets in the same GetTime() second, unless immortal). BP_ACCEPT_OFFER, BP_CANCEL_OFFER and BP_REQ_COUNTEROFFER are NOT throttled. | `kod/object/active/holder/nomoveon/battler/player/user.kod:876-888 (bSpam), 1126-1131 (BP_REQ_OFFER checks bSpam), 1141-1161 (the other three do not)` |
| **silent** | Offering the same object twice in one item_list is rejected. Logs 'ALERT! ... tried to offer a duplicate item to ...'. | `user.kod:4925-4932` |
| **silent** | Every non-NumberItem in item_list must currently be owned by the offerer (GetOwner == self). | `user.kod:4934-4937` |
| **silent** | Every quantity in the derived #number_list must be >= 1. Logs 'Bad offer quantity'. | `user.kod:4943-4950` |
| message | Offerer must not already be in a trade (poOffer_who == $) AND the target must accept offers. For a User target, CanAcceptOffer returns FALSE iff the target is already in a trade. | `user.kod:4952-4959 (sends user_cant_offer to self); CanAcceptOffer at user.kod:5116-5128 (sends user_offer_busy to the offerer)` |
| message | Offering to YOURSELF is refused: CanAcceptOffer passes (poOffer_who is still $), poOffer_who is then set to self, and the subsequent ReqOffer sees poOffer_who <> $ and bails with user_offer_busy. | `user.kod:4952-4953 then 4967 then 5144-5150` |
| message | In an arena room whose watcher has a fight in session, a combatant may not trade with a non-combatant. | `user.kod:4961-4965; kod/object/active/holder/room/necarena.kod:111-136; kod/object/active/holder/room/tosrm/tosarena.kod:122-146; default room IsArena returns FALSE at kod/object/active/holder/room.kod:3265-3268` |
| **silent** | ReqOffer: offerer and target must be in the same room. Logs 'ALERT! <offerer> in RID <n> offered items to <target> in distant RID <m>'. Sends nothing to either client; UserOffer then just calls CleanupCancelOffer and returns. | `user.kod:5134-5141, then 4986-4991` |
| message | ReqOffer: target must not already be in a trade. | `user.kod:5144-5150` |
| message | ReqOffer: target must be logged on (pbLogged_on). | `user.kod:5152-5158` |
| message | ReqOffer: a second, identical same-room check exists but is DEAD CODE — the check at 5134 has the same condition and already returned. | `user.kod:5160-5166 vs 5134` |
| **silent** | ReqOffer: every offered item must pass ReqNewOwnerAttributes(#who=target,#type=1) — item-attribute-level 'can this be given away to this person' veto (type 1 == offer). | `user.kod:5168-5174; kod/object/item.kod:611-633 (loops plItem_Attributes, calls CanGetAffectedItem with type)` |
| message | BP_REQ_COUNTEROFFER requires poOffer_who <> $ (you must be in a trade). | `user.kod:5284-5289` |
| **silent** | Counteroffer quantities must all be >= 1. Logs 'Bad counteroffer quantity'. | `user.kod:5292-5299` |
| **silent** | Duplicate object in a counteroffer list: logs 'ALERT! ... tried to counter-offer a duplicate item ...' and CANCELS the whole trade (both parties get BP_OFFER_CANCELED). | `user.kod:5306-5315 (CancelIfOffer at 5312)` |
| **silent** | Counteroffered items must be owned by the counterofferer. NOTE: this bails mid-loop AFTER plOffer_items was already cleared at 5301 and partially rebuilt, leaving poOffer_who set and plOffer_items truncated — a wedged half-state, not a cancel. | `user.kod:5301, 5317-5320` |
| message | Counteroffered NumberItem quantity must satisfy 1 <= n <= GetNumber() of the held stack — unlike BP_REQ_OFFER, an over-large quantity here is NOT clamped, it cancels the trade. | `user.kod:5322-5331 (CancelIfOffer at 5328)` |
| **silent** | In BP_REQ_OFFER (but NOT in BP_REQ_COUNTEROFFER) a NumberItem quantity is SILENTLY CLAMPED to the amount actually held: Create(GetClass(i),#number=Bound(First(lNumbers),0,Send(i,@GetNumber))). | `user.kod:4975-4976 vs 5324-5331` |
| message | BP_ACCEPT_OFFER requires poOffer_who <> $. | `user.kod:5511-5516` |
| **silent** | BP_ACCEPT_OFFER requires pbOffer_OtherAccepted == TRUE, i.e. you must have received a BP_COUNTEROFFER since... nothing. Failure logs 'ALERT!  Player <name> tried complete an offer without the other person accepting.' and cancels the trade for both. | `user.kod:5518-5525 (CancelIfOffer at 5522); the flag is set only in CounterOffer at user.kod:5382` |
| message | CheckOfferStuff (run on the accepter first, then on the other party if it is a User): every item on your side must pass ReqNewOwner(#what=other). Cancels the trade. | `user.kod:5531-5540, 5394-5406` |
| **silent** | CheckOfferStuff: every item must pass ReqNewOwnerAttributes(#who=other,#type=1). Cancels the trade. | `user.kod:5408-5413` |
| message | CheckOfferStuff: for each NumberItem on your side, you must still hold a stack of the SAME CLASS with GetNumber() >= the offered number. Cancels the trade. | `user.kod:5415-5450` |
| message | CheckOfferStuff: for each non-NumberItem you must still be IsHolding it. Cancels the trade. | `user.kod:5452-5461` |
| message | CheckOfferStuff: the recipient must pass CanHoldWeightAndBulk for the SUM of weight and bulk of your side. Cancels the trade. | `user.kod:5464-5481` |
| message | Entering a new room cancels any pending trade for the mover (and therefore for the counterparty). | `user.kod:6036-6041 (NewOwner -> CancelIfOffer at 6042)` |
| message | Being killed cancels any pending trade. | `user.kod:6896-6898 (Killed -> CancelIfOffer)` |
| message | Logging off cancels any pending trade — CancelIfOffer runs AFTER pbLogged_on is set FALSE, so the leaver's own BP_OFFER_CANCELED at 5269 is emitted to a dying session while the counterparty still gets user_canceled_offer. | `user.kod:652-661 (pbLogged_on = FALSE at 658, CancelIfOffer at 660)` |
| message | A server garbage-collection pause cancels any pending trade for every affected user. | `user.kod:2149-2151 (GarbageCollecting -> CancelIfOffer), followed by BP_WAIT` |
| message | Character suicide/deletion cancels any pending trade. | `user.kod:1425-1431 (PerformSuicide -> CancelIfOffer)` |
| **silent** | NOTHING cancels a trade merely because a party walks around inside the same room, or because either party goes hostile. Only room CHANGE, death, logoff, suicide and GC cancel. Room co-location is re-checked only at ReqOffer time, never at accept time. | `grep of CancelIfOffer over all of kod/ yields only user.kod:660, 1431, 2151, 5312, 5328, 5403, 5410, 5430, 5446, 5459, 5478, 5522, 6042, 6898; UserAcceptOffer (5507-5654) contains no room comparison` |
| **silent** | On the client side, BP_OFFER is ignored outright if any offer dialog is already open (no reply, no cancel) — a purely client-side single-slot guard mirroring the server's. | `clientd3d/offer.c:381-384 (ReceiveOffer returns early if hSendOfferDlg or hRcvOfferDlg is non-NULL)` |
| **silent** | BP_REQ_GIVE(114) and BP_REQ_TAKE(115) are not implemented. They are absent from blakserv/sprocket.c client_def_table, from the kod UserCommand/ReceiveClient dispatch, and from clientd3d/protocol.c — a tree-wide grep finds them only as enum declarations. | `include/proto.h:122-123 and kod/include/protocol.khd:68-69 are the ONLY hits for REQ_GIVE/REQ_TAKE across *.c, *.h, *.kod, *.khd; blakserv/sprocket.c:22-84 has no entry` |

### Constants

- `BP_REQ_OFFER` = 120 — `include/proto.h:128; kod/include/protocol.khd:74`
- `BP_ACCEPT_OFFER` = 121 — `include/proto.h:129; kod/include/protocol.khd:75`
- `BP_CANCEL_OFFER` = 122 — `include/proto.h:130; kod/include/protocol.khd:76`
- `BP_REQ_COUNTEROFFER` = 123 — `include/proto.h:131; kod/include/protocol.khd:77`
- `BP_OFFER` = 211 — `include/proto.h:189`
- `BP_OFFER_CANCELED` = 212 — `include/proto.h:190`
- `BP_OFFERED` = 213 — `include/proto.h:191`
- `BP_COUNTEROFFER` = 214 — `include/proto.h:192`
- `BP_COUNTEROFFERED` = 215 — `include/proto.h:193`
- `BP_REQ_DEPOSIT` = 230 (NPC deposit; shares the offer state machine) — `include/proto.h:208`
- `BP_INVENTORY_ADD / BP_INVENTORY_REMOVE` = 209 / 210 (the only success signal the accepting side gets) — `include/proto.h:185-186; kod .../player/user.kod:6015-6031`
- `BP_REQ_GIVE / BP_REQ_TAKE` = 114 / 115 — declared only, never implemented — `include/proto.h:122-123; kod/include/protocol.khd:68-69`
- `CLIENT_TAG_NORMAL / CLIENT_TAG_NUMBER` = 0 / 1 — value of the top 4 bits of a 4-byte object id on the wire — `include/proto.h:283`
- `GetObjId / GetObjTag / IsNumberObj` = id & 0x0fffffff / (id & 0xf0000000) >> 28 / tag == 1 — `clientd3d/object.h:22-24`
- `NUMBER_OBJECT (kod AddPacket width)` = 5 — writes 4 bytes with CLIENT_TAG_NUMBER forced into the top nibble — `kod/include/protocol.khd:221; blakserv/commcli.c:85-91`
- `SIZE_ID / SIZE_AMOUNT / SIZE_LIST_LEN` = 4 / 4 / 2 — `include/proto.h:507, 518, 509`
- `INCOMING_PACKET_THROTTLE` = 5 packets per second before bSpam blanks BP_REQ_OFFER — `kod .../player/user.kod:50, 876-888`
- `OF_OFFERABLE / OFFER_YES` = 0x00000200 — object flag bit set in a Player's flags word marking it as a valid offer target; cleared when the player is morphed into a monster — `include/proto.h:363; kod/include/blakston.khd:74; kod .../player/user.kod:7306, 7371`
- `Money class` = Money is NumberItem; carries piNumber as the stacked quantity; viBulk=0, viWeight=0, viValue_average=1 — `kod/object/item/passitem/numbitem/money.kod:11, 35-39; kod/object/item/passitem/numbitem.kod:11, 44 (piNumber = 1)`
- `SystemHolder1 / SystemHolder2` = two GLOBAL singleton holder objects used as the escrow for every trade in the game — `kod/util/system.kod:1378-1386; used at kod .../player/user.kod:5545, 5555, 5601, 5609`

### What two agents can exploit or must respect

- MINIMAL SUCCESSFUL P2P GIVE, exact packet order. A->S: BP_REQ_OFFER(120) [4-byte B id, count, items]. S->A: BP_OFFERED(213). S->B: BP_SYS_MESSAGE(user_got_offer) then BP_OFFER(211). B->S: BP_REQ_COUNTEROFFER(123) with count=0. S->B: BP_COUNTEROFFERED(215) count=0. S->A: BP_COUNTEROFFER(214) count=0 (this is what unlocks A). A->S: BP_ACCEPT_OFFER(121). S->B: BP_INVENTORY_ADD per item, then BP_OFFER_CANCELED(212). S->A: BP_INVENTORY_REMOVE per item. A gets NO terminal packet.
- The receiving agent's 'accept' is NOT BP_ACCEPT_OFFER — it is BP_REQ_COUNTEROFFER, possibly with a zero-length list. Only the party holding pbOffer_OtherAccepted==TRUE may send BP_ACCEPT_OFFER, and that flag is set exclusively inside CounterOffer (user.kod:5382). An agent that sends BP_ACCEPT_OFFER as the offer *recipient* right after BP_OFFER will trip the 'ALERT!' Debug at user.kod:5520 and kill the trade.
- The roles are symmetric in the protocol even though the stock client hardcodes them. After B counteroffers, A may itself send BP_REQ_COUNTEROFFER: that REPLACES A's plOffer_items (user.kod:5301) and sets B's pbOffer_OtherAccepted=TRUE, after which B is the one who sends BP_ACCEPT_OFFER. Two cooperating agents can therefore haggle indefinitely, alternating counteroffers, and either may be the finalizer.
- EXPLOITABLE: CleanupCancelOffer (user.kod:5227-5242) resets poOffer_who and plOffer_items but NEVER resets pbOffer_OtherAccepted. So a trade that reached the counteroffer stage and was then cancelled leaves the flag TRUE, and the NEXT offer that player makes can be accepted immediately with zero counteroffer from the new partner. Two cooperating agents can use this deliberately (one-round-trip trades after a throwaway first trade); an agent guarding against it cannot rely on 'they haven't countered yet' as safety.
- Both parties' plOffer_items are collected and BOTH sides' CheckOfferStuff run before any item moves (user.kod:5531-5540), so the transfer is atomic within one blakod message — there is no window where one side has given and the other has not. But it is NOT idempotent-safe against re-entry: SystemHolder1/SystemHolder2 are global singletons (kod/util/system.kod:1378-1386) shared by every trade, every pawnbroker sale (pawnman.kod:112-120), Oblak repair (oblak.kod:179-191), and monster buy (monster.kod:3187-3195). Anything that leaves items sitting in those holders will be swept into the next unrelated accept.
- Money is included by setting the object id's top nibble to 1 and appending a 4-byte quantity immediately after the id, INSIDE the object list. There is no separate money field and no separate opcode. The quantity is the number of shillings. On BP_REQ_OFFER an over-large quantity is silently clamped to what you hold (user.kod:4975-4976); on BP_REQ_COUNTEROFFER an over-large quantity CANCELS the trade (user.kod:5324-5331). Prefer BP_REQ_OFFER semantics if you are unsure of your balance.
- The ids the server hands back in BP_OFFERED / BP_COUNTEROFFERED for NumberItems are NEW temporary objects (Create at user.kod:4975, 5333), not your inventory ids. Do not correlate them with inventory. They are deleted by CleanupCancelOffer on cancel (user.kod:5232-5239) and handed over as real objects on success.
- OfferSubtractNumberItems (user.kod:5486-5505) loops plPassive and subtracts the offered amount from EVERY stack whose GetClass matches — not just one. A player holding two separate stacks of the same NumberItem class loses the amount twice. Relevant if you ever end up with split stacks.
- Only ONE trade per player at a time, enforced on both sides by poOffer_who <> $ (user.kod:4952, 5119, 5144, 5184). A pending BP_REQ_DEPOSIT to a vaultman/banker occupies the same slot (UserDeposit sets poOffer_who at user.kod:5046), and so does an NPC pawn/repair interaction. An agent must drain or cancel any NPC transaction before it can be offered to.
- Detecting refusal is unreliable: many rejections send NOTHING. Specifically silent: throttled BP_REQ_OFFER, duplicate item, item not owned, quantity < 1, different-room ReqOffer, item-attribute veto. An agent must therefore arm a timeout after BP_REQ_OFFER and treat absence of BP_OFFERED within that window as failure. Same for BP_REQ_COUNTEROFFER (expect BP_COUNTEROFFERED).
- The accepting party receives no completion packet at all — only BP_INVENTORY_REMOVE for what it gave and BP_INVENTORY_ADD for what it got (user.kod:6015-6031). The non-accepting party receives BP_OFFER_CANCELED, which is byte-identical to a cancellation. So BP_OFFER_CANCELED alone cannot distinguish success from abort; correlate it with whether BP_INVENTORY_ADD arrived for the counterparty's items.
- If the recipient cannot carry an item at hand-off time, ReqNewHold fails and the item is dropped on the FLOOR of the recipient's room at their coordinates (user.kod:5570-5583 and 5623-5640) rather than being returned. On the non-accepting side that path also emits user_cant_offer_get = "You can't take %s%s from the trade -- it is on the ground." (user.kod:5635-5636). Weight/bulk is pre-checked by CheckOfferStuff, so this is a rare secondary path, but agents should re-read inventory after a trade rather than assuming.
- Both offer/counteroffer lists have variable per-element stride (4 or 8 bytes depending on the tag nibble). If you are writing a raw serializer, the count field is the number of ELEMENTS, not bytes, and the stock client's own serializer culls tagged elements with amount <= 0 AFTER computing the count (clientd3d/protocol.c:270-289) — recompute the count yourself over the post-cull set or the server's parse will run off the end.
- ExtractObjectList on the client requires the object list to consume EXACTLY the remaining message bytes (clientd3d/server.c:430-435). For BP_OFFER that means the offerer object must be parsed with full lighting (includeLight defaults true, clientd3d/server.h:47), and every embedded object in the list likewise (ExtractNewObject -> ExtractObject with the default, server.c:365-370). Skipping the dLighting block will desync the entire list with no error.

### Not determined

- The outer transport framing around every client->server and server->client message (length prefix, sequence/CRC, encryption) is not covered here — I only traced payloads from the opcode byte onward. blakserv/sprocket.c / parsecli.c receive msg_data/msg_len already de-framed, and clientd3d/server.c HandleMessage (server.c:519) likewise. Look at blakserv/session.c and clientd3d/client.c/dllfuncs for the framing.
- I did not enumerate which concrete item attributes can veto a trade via ReqNewOwnerAttributes(#type=1) / CanGetAffectedItem, nor whether any of them emits a user-visible BP_MESSAGE. Entry point is kod/object/item.kod:611-633 plus the ItemAtt subclasses under kod/object/passive/; I only confirmed the hook, not its implementations.
- I did not verify the exact byte layout of the animation/overlay tail for a Player object specifically (BP_OFFER embeds one). ToCliObject calls Send(what,@SendAnimation)/@SendOverlays (user.kod:2453-2454) which resolve on Player, and Player also overrides SendLightingInformation (player.kod:12450) to emit a possibly-5-byte dLighting block. If you hand-parse BP_OFFER you should confirm against a real capture; the generic Item versions are at kod/object/item.kod:636-680.
- user_offer_too_many ("You can't offer that many %s!", user.kod:166) has no Send site anywhere in kod — I grepped all of kod/ and found only the declaration. It appears to be dead. I could not find a code path that produces it.
- Whether two BP_REQ_COUNTEROFFERs in a row from the same side are intended: the second rebuilds plOffer_items at user.kod:5301 without deleting the temporary NumberItem objects created by the first, leaking them. I confirmed the leak in the source but did not confirm the server's garbage collector reclaims them.
- I did not test the actual behavior of the wedged half-state produced by user.kod:5317-5320 (counteroffer bails mid-loop with poOffer_who still set and plOffer_items truncated). Whether a subsequent BP_ACCEPT_OFFER then transfers a partial list is a source-level inference, not a verified observation.
- Whether the BP_REQ_OFFER target id may legally carry a non-zero tag nibble: the stock client masks it (clientd3d/protocol.c:212, GetObjId) and parsecli.c:363-388 would then consume 4 EXTRA bytes for a phantom amount, desyncing the rest of the message. I did not confirm what the server does with the resulting malformed parse beyond the generic short-message eprintf at parsecli.c:389-395.


---

## LOOT, CORPSES and CONTAINERS (monster death -> treasure -> player pickup)

Treasure does NOT go into the corpse. `Monster Killed` creates a `DeadBody` (a PassiveObject, not a Holder, so it is neither OF_CONTAINER nor OF_GETTABLE) and puts it on the room floor, then calls `CreateTreasure`, which drops every generated item plus the monster's own plActive/plPassive inventory directly onto the room floor at the monster's row/col via `Send(poOwner,@NewHold,...)`. Each item is created with `#corpse=oBody`, which makes `Item Constructor` attach an `IA_CORPSEPOINTER` item attribute pointing at the corpse. That attribute is the entire loot-rights system: `UserGet` calls `ReqNewOwnerAttributes`, which asks the corpse `CanGetMe(who)`, and the corpse returns FALSE for anyone whose `GetTrueName` is not the killer's name — but only for the 25 seconds that the corpse's `ptNoSteal` timer is alive. After 25s the loot is a free-for-all for anyone within Manhattan distance 7 of the item's tile, with no queue, reservation, or per-item claim. There is no BP_OBJECT_CONTENTS involvement in monster looting at all (BP_SEND_OBJECT_CONTENTS on a DeadBody is refused with `user_err_get_contents` because DeadBody is not a Holder; the only real containers in the game are `SafeBox` and `StoreBox`). Money IS a single stacked `Money` NumberItem and CAN be split: `BP_REQ_GET(113)` always takes the whole stack, but `BP_REQ_GET_FROM_CONTAINER(239)` carries a number-tagged object id plus a 4-byte amount and routes to the same `UserGet` with `#number`, which calls `Split` — so an exact 50/50 shilling split is mechanically possible from the floor, not just by alternating whole items. Mob corpses vanish after 120s, player corpses after 600s, and floor items are garbage-collected by the room's `DisposeTimer` every ~300s (±5s).

### Wire formats

**BP_SEND_OBJECT_CONTENTS (43) — client->server**

```
byte0: 43 (opcode)
bytes1-4: object id (4, TAG_OBJECT) — the Holder to look inside. Client sends it via PARAM_ID, i.e. masked with 0x0fffffff (no tag nibble, no amount).
```

*include/proto.h:72 (=43); blakserv/sprocket.c:26 `{ BP_SEND_OBJECT_CONTENTS, { {4, TAG_OBJECT}, {0, DONE_PARM} } }`; clientd3d/protocol.c:69 `{ BP_SEND_OBJECT_CONTENTS, { PARAM_ID, PARAM_END } }`; clientd3d/protocol.h:77 `#define RequestObjectContents(id) ToServer(BP_SEND_OBJECT_CONTENTS, NULL, id)`; dispatch at kod/object/active/holder/nomoveon/battler/player/user.kod:1011-1020*

Rate-limited: if the sender is flagged bSpam (more than INCOMING_PACKET_THROTTLE packets in one second, user.kod:874-884) the server silently returns with NO reply at all (user.kod:1013-1016). Refused with a BP_MESSAGE if the target is not a &Holder, or is a &Player other than yourself, or is not in your room (user.kod:3979-3996).

**BP_OBJECT_CONTENTS (135) — server->client**

```
byte0: 135 (opcode)
bytes1-4: container object id (4, raw kod object id — NOT number-tagged)
bytes5-6: iObjs = Length(plActive)+Length(plPassive) (2 bytes LE)
then iObjs consecutive "object" payloads, packed with no per-item length:
  each = id(4) [amount(4) only if top nibble of id == 1] iconRsc(4) nameRsc(4) flags(4) rarity(4) dLighting paletteTranslation animation overlays
  - dLighting = flags(2), plus intensity(1)+color(2) ONLY if flags != 0
  - paletteTranslation = 1 byte peeked; consumed as 2 bytes only if it is 9 (ANIMATE_TRANSLATION) or 10 (ANIMATE_EFFECT), else rewound
  - animation = 1 byte type then 2 (type 1) / 8 (type 2) / 10 (type 3) more
  - overlays = 1 byte count, then that many overlay records
Active holdings are emitted first, then passive holdings. show_type is SHOW_NORMAL, so SendAnimation/SendOverlays are used (not the Look/Inventory variants).
```

*kod/object/active/holder/nomoveon/battler/player/user.kod:4010 `AddPacket(1,BP_OBJECT_CONTENTS,4,what,2,iObjs);` then 4012-4025 loop calling `Send(self,@ToCliObject,#what=oThing)`; parsed at clientd3d/server.c:792-808 HandleObjectContents -> ExtractObjectList (server.c:414-437) -> ExtractNewObject -> ExtractObject (server.c:319-352); includeLight defaults true at clientd3d/server.h:48; ExtractDLighting at clientd3d/server.c:300-313; object payload built by ToCliObject at user.kod:2331-2461*

DESYNC HAZARD: there is no per-item length and no terminator. ExtractObjectList requires the byte count to come out EXACTLY (server.c:431-435 `if (len != 0) return LIST_ERROR`), so a single mis-sized field discards the whole message. The amount field is present iff the 4-byte id has top nibble 1 (CLIENT_TAG_NUMBER); ToCliObject emits `AddPacket(NUMBER_OBJECT,what, 4,Send(what,@GetNumber))` for NumberItems (user.kod:2339-2340) and a plain `AddPacket(4,what)` otherwise (user.kod:2344). The 2-byte count is `Length(plActive)+Length(plPassive)` — an empty container legitimately sends count 0.

**BP_REQ_GET (113) — client->server**

```
byte0: 113
bytes1-4: object id (4, TAG_OBJECT). Client sends PARAM_ID = GetObjId(id) = id & 0x0fffffff, so the tag nibble is STRIPPED and no amount is ever appended.
```

*include/proto.h:120-121 (BP_REQ_PUT=112, BP_REQ_GET=113); blakserv/sprocket.c:36 `{ BP_REQ_GET, { {4, TAG_OBJECT}, {0, DONE_PARM} } }`; clientd3d/protocol.c:37 `{ BP_REQ_GET, { PARAM_ID, PARAM_END } }`; PARAM_ID encoding at clientd3d/protocol.c:211-215; dispatch at user.kod:969-975 `Send(self,@UserGet,#what=oWhat);`*

kod deliberately does NOT pass number_stuff here (user.kod:972), so BP_REQ_GET on a Money/NumberItem stack ALWAYS attempts the whole stack. Even if you hand-craft a number-tagged id plus 4-byte amount, parsecli.c will parse the amount into number_stuff (parsecli.c:373-386) but the kod handler ignores it. Note parsecli.c strips nothing: kod sees the object with its tag nibble already resolved by GetObjectByID lookup on temp.v.data (parsecli.c:361-364).

**BP_REQ_GET_FROM_CONTAINER (239) — client->server**

```
byte0: 239
bytes1-4: object id (4, TAG_OBJECT) — sent as PARAM_OBJECT, i.e. the FULL obj->id INCLUDING the top tag nibble
bytes5-8: amount (4, SIZE_AMOUNT) — present ONLY if the id's top nibble == 1 (CLIENT_TAG_NUMBER)
The client suppresses the whole message if the object is a number object and temp_amount <= 0.
```

*include/proto.h:217 `BP_REQ_GET_FROM_CONTAINER = 239`; blakserv/sprocket.c:37 `{ BP_REQ_GET_FROM_CONTAINER, { {4, TAG_OBJECT}, {0, DONE_PARM} } }`; clientd3d/protocol.c:38 `{ BP_REQ_GET_FROM_CONTAINER, { PARAM_OBJECT, PARAM_END } }`; PARAM_OBJECT encoding at clientd3d/protocol.c:216-224; server-side amount pickup at blakserv/parsecli.c:373-386; dispatch at user.kod:977-983 `Send(self,@UserGet,#what=oWhat,#number=number_stuff);`*

THIS IS THE PARTIAL-QUANTITY PICKUP PATH. The sprocket table says only {4, TAG_OBJECT}, but parsecli.c case 4 appends a hidden extra 4-byte read when the incoming 32-bit value's tag nibble is CLIENT_TAG_NUMBER (=1), and hands it to kod as `number_stuff`. Despite the name, the server does NOT require the item to be in a container — UserGet only checks that UtilGetRoom(what) == your room and Manhattan distance <= 7, so this opcode works on a FLOOR money stack. The vanilla client only ever sends it from GotObjectContents (clientd3d/gameuser.c:158), which is why partial floor pickup is not reachable from the stock UI.

**BP_REQ_DROP (118) — client->server**

```
byte0: 118
bytes1-2: count (2, SIZE_LIST_LEN) — number of entries that FOLLOW (already culled)
then per entry: id(4, full id including tag nibble) [amount(4) only if top nibble == 1]
Entries whose id is number-tagged with temp_amount <= 0 are dropped from the list by the client before the count is written, so count can legitimately be 0.
```

*include/proto.h:126 `BP_REQ_DROP = 118`; blakserv/sprocket.c:38 `{ BP_REQ_DROP, { {2, LIST_OBJ_PARM}, {0, DONE_PARM} } }`; clientd3d/protocol.c:41 and the PARAM_OBJECT_LIST encoder at clientd3d/protocol.c:261-288; server parse at blakserv/parsecli.c:276-312; dispatch at user.kod:985-990 `Send(self,@UserDropItems,#item_list=lItems,#number_list=number_stuff);`*

YES, partial-quantity drop IS possible and is in fact MANDATORY for NumberItems. LIST_OBJ_PARM builds TWO kod lists: the object list (client_msg) and a parallel `number_stuff` list containing only the amounts of the number-tagged entries (parsecli.c:305-315). UserDropItems walks item_list and pops First(number_list) ONLY when the item IsClass &NumberItem (user.kod:3775-3781), so the two lists MUST agree on which entries are number items or the amounts desynchronise silently. UserDrop then refuses a NumberItem when `number <= 0` with `user_cant_deal_number` (user.kod:3802-3808) and calls Split for the requested amount (user.kod:3811). IMPORTANT ORDERING: parsecli.c:296-297 comments "object lists will be in reverse order" — Cons builds the kod list back-to-front, so the kod item_list is the REVERSE of the wire order (and number_stuff likewise), which is why the pairing still lines up.

**BP_REQ_PUT (112) — client->server**

```
byte0: 112
bytes1-4: what — object id (4, PARAM_OBJECT, full id with tag nibble)
[bytes5-8: amount(4) only if what's top nibble == 1]
next 4 bytes: where — destination Holder id (4, PARAM_ID, masked, never number-tagged)
```

*include/proto.h:120 `BP_REQ_PUT = 112`; blakserv/sprocket.c:40 `{ BP_REQ_PUT, { {4, TAG_OBJECT}, {4, TAG_OBJECT}, {0, DONE_PARM} } }`; clientd3d/protocol.c:42 `{ BP_REQ_PUT, { PARAM_OBJECT, PARAM_ID, PARAM_END } }`; clientd3d/protocol.h:83; dispatch at user.kod:1001-1008 `Send(self,@UserPut,#what=oWhat,#where=oWhere,#number=number_stuff);`*

The optional 4-byte amount sits BETWEEN the two object ids, so a naive fixed-offset parser reading `where` at byte 5 is wrong for stacks. Only ONE number-tagged parm per message is supported (parsecli.c:375-377 eprintf "found more than one number parm"), so `where` must never be number-tagged. UserPut refuses `where` that IsClass &User (logs "tried to 'put' items into player", user.kod:3891-3897) and refuses non-&Holder with user_err_put (user.kod:3899-3908).

**BP_MESSAGE (32) — server->client**

```
byte0: 32
bytes1-4: message resource id (4)
then 0..8 optional parms, each written with the width given by its typeN (default STANDARD_RESOURCE = 4 bytes). A parm is emitted ONLY if it is not $, and the sequence stops being meaningful once one is skipped — there is no count and no per-parm tag on the wire.
```

*include/proto.h:67 `BP_MESSAGE = 32`; kod/object/active/holder/nomoveon/battler/player/user.kod:3207-3255 MsgSendUser; STANDARD_RESOURCE = 4 at kod/include/protocol.khd:219*

This is how every loot refusal reaches an agent — there is no structured error code. To detect a loot-rights denial you must match the resource id of `corpsepointer_no_loot` (kod/object/passive/itematt/iacorptr.kod:37) or `PKpointer_no_loot` (kod/object/passive/itematt/iaPKptr.kod:36). Because a $ parm is simply omitted, the parm list is variable-length with no length prefix.

**BP_CREATE (217) — server->client**

```
byte0: 217
then one "object" payload (ToCliObject, SHOW_NORMAL — same layout as inside BP_OBJECT_CONTENTS)
then: row*FINENESS+fine_row (2), col*FINENESS+fine_col (2), angle (2)
then SendMoveAnimation then SendMoveOverlays
```

*include/proto.h:191 `BP_CREATE = 217`; kod/object/active/holder/nomoveon/battler/player/user.kod:6126-6136*

This is the only push notification that loot has appeared on the floor — one BP_CREATE per treasure item and one for the DeadBody, emitted as the room NewHolds each object. Removal is BP_REMOVE(218) = opcode + 4-byte object id (user.kod:6152). There is no server->client message announcing loot rights, so an agent CANNOT tell from the wire whether an item is claimed; it can only try and parse the BP_MESSAGE refusal.

### Rules, in the order the server checks them

| | rule | where |
|---|---|---|
| **silent** | Monster treasure is placed on the ROOM FLOOR at the monster's tile, never inside the corpse. CreateTreasure builds a list (generated treasure + the monster's own plActive and plPassive inventory) and for each item calls ReqNewHold + ReqSomethingMoved on poOwner (the room) then NewHold at #new_row=piRow,#new_col=piCol. If the room refuses either request the item is Deleted outright. | `kod/object/active/holder/nomoveon/battler/monster.kod:5019-5037 (`for oTreasure in lTreasureItems { if Send(poOwner,@ReqNewHold,...) AND Send(poOwner,@ReqSomethingMoved,...) { Send(poOwner,@NewHold,...) } else { Send(oTreasure,@Delete); } }`); inventory folded in at monster.kod:5006-5016; call site monster.kod:3108` |
| message | The corpse is NOT a container and NOT gettable. DeadBody is a PassiveObject, so it is not a &Holder; a mob corpse reports flags LOOK_NO|drawfx (i.e. OF_NOEXAMINE, no OF_GETTABLE 0x10, no OF_CONTAINER 0x20) and a player corpse reports viObject_flags|drawfx where viObject_flags is 0. | `kod/object/passive/body.kod:11 `DeadBody is PassiveObject`; kod/object/passive/body.kod:184-192 GetObjectFlags; kod/object.kod:79 `viObject_flags = 0`; kod/include/blakston.khd:62-68 (GETTABLE_YES=0x10, CONTAINER_YES=0x20, LOOK_NO=0x40); include/proto.h:360-362` |
| message | BP_SEND_OBJECT_CONTENTS(43) on a corpse is refused, because UserObjectContents requires IsClass(what,&Holder). The only classes in the entire kod tree that set CONTAINER_YES are SafeBox and StoreBox. | `kod/object/active/holder/nomoveon/battler/player/user.kod:3980-3991; grep for CONTAINER_YES hits only kod/object/active/holder/safebox.kod:24 and kod/object/active/holder/storebox.kod:39,51,184,189` |
| message | LOOT RIGHTS EXIST, and are implemented purely as a per-ITEM attribute IA_CORPSEPOINTER(=1) that points at the corpse object. Item Constructor attaches it whenever the item is Created with a non-$ #corpse parameter. | `kod/object/item.kod:114-127 (`if corpse <> $ { oItemAtt = Send(SYS,@FindItemAttByNum,#num=IA_CORPSEPOINTER); ... Send(oItemAtt,@AddToItem,#oItem=self,#state1=corpse); }`); kod/include/blakston.khd:1649 `IA_CORPSEPOINTER = 1`; registered at kod/util/system.kod:3102` |
| message | The gate itself: UserGet calls ReqNewOwnerAttributes(who=self), which iterates the item's attributes and calls CanGetAffectedItem. ItemAttCorpsePointer asks the corpse Send(oCorpse,@CanGetMe,#what=who) and returns FALSE if the corpse says no. | `kod/object/active/holder/nomoveon/battler/player/user.kod:3643-3648 (with the comment "This includes the corpse pointer, which prevents people from looting each other's kills."); kod/object/item.kod:611-632; kod/object/passive/itematt/iacorptr.kod:57-73` |
| message | DeadBody.CanGetMe returns TRUE for EVERYONE once its ptNoSteal timer has fired (25000 ms after the corpse was created). Before then it returns TRUE only if Send(what,@GetTrueName) equals prPlayer_name, which for a mob corpse is the killer's true name. There is no Admin/DM bypass in CanGetMe. | `kod/object/passive/body.kod:100 `ptNoSteal = CreateTimer(self,@NoStealTimer,25000);`; body.kod:103-107 NoStealTimer; body.kod:111-123 CanGetMe; killer name set at kod/object/active/holder/nomoveon/battler/monster.kod:3060-3068 `#playername=Send(killer,@GetTrueName)`` |
| **silent** | Several treasure paths bypass the corpse pointer entirely, producing items that are free-for-all from the instant they hit the floor: (a) GenerateTreasure returns early WITHOUT passing #corpse for Tokens, the newbie signet ring, and item-attributed weapons; (b) if the killer `who` IsClass &Monster, or the corpse IsClass &OrcPitBossBody, the item is Created with no corpse at all; (c) the monster's own plActive/plPassive inventory items are appended to the drop list in CreateTreasure and never get a pointer; (d) if vrDead_icon is $ then CreateDeadBody returns $ and corpse=$ throughout. | `kod/object/passive/trestype.kod:225-241 (token early return), 243-263 (signet ring early return), 265-281 (item-att early return), 289-298 (`if isClass(who,&Monster) or isClass(corpse,&OrcPitBossBody) { oObj = Create(First(lItem_info)); } else { oObj = Create(First(lItem_info),#corpse=corpse); }`); kod/object/active/holder/nomoveon/battler/monster.kod:5005-5016 (inventory appended raw); monster.kod:3054-3070 CreateDeadBody returns $ when vrDead_icon = $` |
| **silent** | The corpse pointer is destroyed early in three ways, all of which open the loot to everyone: the corpse's Delete sends CorpseFading to the room, which broadcasts ObjectCorpseFading to every object; each item holding a pointer at that corpse removes it. Also Item.NewOwner strips IA_CORPSEPOINTER as soon as ANY owner picks the item up. | `kod/object/passive/body.kod:143-151 Delete -> `send(poOwner,@CorpseFading,#corpse=self)`; kod/object/active/holder/room.kod:3283-3298 CorpseFading; kod/object/item.kod:909-931 ObjectCorpseFading; kod/object/item.kod:488-499 NewOwner (`if poOwner <> $ AND Send(self,@HasAttribute,#ItemAtt=IA_CORPSEPOINTER) { Send(self,@RemoveAttribute,...) }`)` |
| message | There is NO other ownership, reservation, first-hit claim, per-player queue, or damage-share tracking on a corpse or its contents anywhere in the get path. Holder.ReqTaker is an unconditional `return TRUE` (only StoreBox overrides it, and only to reject cross-room reach and to delegate guild-chest rules). Item.ReqNewOwner only asks the current owner's ReqLeaveHold. Player/User add no further pickup gate. | `kod/object/active/holder.kod:993-996 `ReqTaker() { return TRUE; }`; kod/object/active/holder/storebox.kod:129-150; kod/object/item.kod:589-592 `ReqNewOwner(what=$) { return ((poOwner = $) OR Send(poOwner,@ReqLeaveHold,#what=self)); }`; ReqNewOwnerAttributes has only 3 call sites in the whole tree — user.kod:3645 (get), 5171 and 5408 (offer), grep-confirmed` |
| message | UserGet checks, in this exact order: (1) oOldOwner = self -> silent return; (2) UtilGetRoom(what) <> poOwner OR GetOwner(what) IsClass &User -> user_err_get_unk; (3) GetPos = $ -> user_err_get_unk; (4) Manhattan distance |piRow-itemRow| + |piCol-itemCol| > 7 -> user_err_get_dist; (5) ReqNewOwnerAttributes (corpse pointer / PK pointer); (6) oOldOwner.ReqTaker -> user_disallow_get; (7) what.ReqNewOwner -> user_disallow_get; (8) capacity / NumberItem split. | `kod/object/active/holder/nomoveon/battler/player/user.kod:3576-3751; distance test at 3620-3641; refusal strings at user.kod:75-78` |
| **silent** | Step (1) of UserGet — `if oOldOwner = self { return; }` — produces NO client message whatsoever. Likewise the bSpam throttle on BP_SEND_OBJECT_CONTENTS returns with no reply. | `kod/object/active/holder/nomoveon/battler/player/user.kod:3593-3596; user.kod:1011-1016` |
| message | Money splitting IS possible. UserGet enters its NumberItem branch when `number <> $` (i.e. an amount arrived via BP_REQ_GET_FROM_CONTAINER) OR when the whole stack will not fit. It computes iCan_hold = your remaining capacity, clamps iNumber = Bound(iCan_hold, $, number) = min(capacity, requested), and calls Send(what,@Split,#number=iNumber). Split creates a NEW object of the same class with that count and SubtractNumbers the original. | `kod/object/active/holder/nomoveon/battler/player/user.kod:3667-3712 (3683 `iNumber = bound(iCan_hold,$,number);`, 3686 `oSplit = Send(what,@Split,#number=iNumber);`); Split at kod/object/item/passitem/numbitem.kod:243-256; SubtractNumber at numbitem.kod:203-231 (deletes self if the remainder would be <= 0); Bound(value,min,max) with NIL bounds ignored, blakserv/ccode.c:1999-2040` |
| message | Money is weightless and bulkless, so capacity never limits a shilling pickup: viBulk = 0 and viWeight = 0 make GetNumberCanHold return INFINITE_COUNT (-1), which UserGet then replaces with the requested `number`. | `kod/object/item/passitem/numbitem/money.kod:35-36 `viBulk = 0 / viWeight = 0`; GetNumberCanHold at kod/object/item/passitem/numbitem.kod:93-141; holder wrapper kod/object/active/holder.kod:302-313; kod/include/blakston.khd:19 `INFINITE_COUNT = -1`; user.kod:3674-3682` |
| message | BP_REQ_GET(113) on a stack always takes ALL of it — kod never passes number_stuff for that opcode. Partial pickup requires BP_REQ_GET_FROM_CONTAINER(239). | `kod/object/active/holder/nomoveon/battler/player/user.kod:969-983 (BP_REQ_GET at 972 has no #number; BP_REQ_GET_FROM_CONTAINER at 980 has `#number=number_stuff`)` |
| message | Partial DROP is possible and is required for NumberItems: UserDrop refuses a NumberItem drop whose number <= 0, then Splits exactly `number` off and NewHolds the split object in the room. Non-NumberItems ignore number entirely. | `kod/object/active/holder/nomoveon/battler/player/user.kod:3791-3847 (3802-3808 refusal, 3811 Split, 3818-3823 room NewHold, 3830-3836 whole-object path); UserDropItems pairing loop at user.kod:3762-3789` |
| **silent** | Room.NewHold AUTO-MERGES a NumberItem into any existing same-class NumberItem at the SAME row/col unless #merge=FALSE is passed. The incoming object is Deleted and its count is AddNumber'd onto the resident stack. Monster CreateTreasure does NOT pass merge, so it defaults to TRUE — monster money merges into whatever shilling stack is already on that tile. | `kod/object/active/holder/room.kod:1707-1709 (signature, `merge = TRUE`), 1734-1752 (merge loop, 1746 `Send(each_obj,@AddNumber,#number=Send(what,@GetNumber));` then 1747 `Send(what,@Delete);`); monster.kod:5030-5033 calls NewHold with no #merge` |
| **silent** | Player-holder NewHold also auto-joins: picking up shillings merges into your existing shilling stack in inventory (same-class NumberItem anywhere in plPassive, no position condition). | `kod/object/active/holder.kod:315-349 (326-344 join loop)` |
| **silent** | Mob corpses self-delete after 120000 ms (120 s). Player corpses self-delete after 600000 ms (600 s) and are also registered with the Underworld room. Both are IMMUNE to room garbage collection: DeadBody.DestroyDisposable is a no-op. | `kod/object/passive/body.kod:84-96 (`if mob { ptDelete = CreateTimer(self,@DeleteTimerMessage,120000); } else { ptDelete = CreateTimer(self,@DeleteTimerMessage,600000); ... }`); body.kod:154-160 DeleteTimerMessage; body.kod:162-165 `DestroyDisposable() { return; }`` |
| **silent** | Floor items are garbage-collected by the room's DisposeTimer, which reschedules itself every piDispose_delay + Random(-5000,5000) ms; the base is 300000 ms (5 min). If ANY player corpse (DeadBody with WasPlayer) is in plPassive, the sweep returns immediately and nothing is cleaned. If no user is in the room, EVERYTHING disposable is destroyed. If a user is present and Length(plPassive) > 5, only the entries past index 4*len/5 are destroyed — and since HolderAddNode Conses new nodes to the FRONT, that tail is the OLDEST items. | `kod/object/active/holder/room.kod:1466-1515 DisposeTimer; piDispose_delay = 300000 at room.kod:214; initial timer at room.kod:285-286; Cons-to-front at kod/object/active/holder.kod:905 `plPassive = Cons(node,plPassive);`; overrides: kod/object/active/holder/room/monsroom/bossroom/orcpit1.kod:89 (3 min), kod/object/active/holder/room/monsroom/throne1.kod:51 (2 min)` |
| **silent** | An Item's DestroyDisposable Deletes it unless it carries IA_BONDED. Note it does NOT check IA_CORPSEPOINTER, so unlooted treasure can be garbage-collected while still 'reserved'. | `kod/object/item.kod:376-385` |
| **silent** | Dropping an item into a room resets that room's dispose timer to 60000 ms if less than a minute remained, so a freshly dropped item gets at least ~60 s. This only fires when the item's previous owner IsClass &Player. | `kod/object/active/holder/room.kod:1769-1794 NewHoldObject` |
| message | PLAYER-vs-PLAYER loot uses a different, much longer gate: IA_PKPOINTER with a 10-minute timer, attached to each dropped item only if the killer IsClass &User. It refuses anyone who is not the dead player and does not have PFLAG_PKILL_ENABLE. If a MONSTER killed the player, no pointer is attached at all and the loot is instantly free-for-all. | `kod/object/active/holder/nomoveon/battler/player.kod:8050-8080 (8052-8059 chooses oItemAtt = $ when `(what = $) OR (NOT IsClass(what,&user))`, 8069-8073 AddToItem with #timer_duration=PKPOINTER_TIME); PKPOINTER_TIME = 10*60*1000 at player.kod:70; gate logic kod/object/passive/itematt/iaPKptr.kod:57-88; ghost-penalty drops at player.kod:2519-2531` |
| **silent** | Player death drops inventory onto the floor with #merge=FALSE, so a dead player's shillings form a SEPARATE stack rather than merging with existing floor money. | `kod/object/active/holder/nomoveon/battler/player.kod:8076 `Send(oRoom,@NewHold,#what=i,#new_row=iRow,#new_col=iCol,#merge=FALSE);`` |
| message | The OFFER path is gated identically (type=1), so loot cannot be laundered by having the entitled player offer it to someone else while the pointer is live. | `kod/object/active/holder/nomoveon/battler/player/user.kod:5171 and 5408 (`Send(i,@ReqNewOwnerAttributes,#who=...,#type=1)`); type-1 branches at kod/object/passive/itematt/iaPKptr.kod:74-85` |
| **silent** | The Sweep spell will not pick up any item that still carries IA_CORPSEPOINTER, so it cannot be used to bulk-vacuum another player's reserved kill. | `kod/object/passive/spell/sweep.kod:130-141` |
| **silent** | FactionTroop overrides CreateTreasure entirely (does not propagate): each equipped item has a 20% chance to drop, gets an explicit IA_CORPSEPOINTER pointed at the corpse, and non-dropped items are Deleted. The quest shield never drops. | `kod/object/active/holder/nomoveon/battler/monster/troop.kod:1032-1065; EQUIPMENT_DROP_PERCENT = 20 at troop.kod:33` |
| message | DeadLich uses a LIST-based claim instead of a single name: CanGetMe returns TRUE if the requester appears anywhere in plKilledBy. This is the only multi-claimant corpse in the tree. | `kod/object/active/holder/nomoveon/battler/monster/deadlich.kod:145-158` |

### Constants

- `BP_SEND_OBJECT_CONTENTS` = 43 (client->server request) — `include/proto.h:72; kod/include/protocol.khd:23`
- `BP_OBJECT_CONTENTS` = 135 (server->client reply) — `include/proto.h:142; kod/include/protocol.khd:88`
- `BP_REQ_PUT` = 112 — `include/proto.h:120; kod/include/protocol.khd:66`
- `BP_REQ_GET` = 113 — `include/proto.h:121; kod/include/protocol.khd:67`
- `BP_REQ_DROP` = 118 — `include/proto.h:126; kod/include/protocol.khd:72`
- `BP_REQ_GET_FROM_CONTAINER` = 239 — confirmed present in blakserv/sprocket.c client_def_table as { {4, TAG_OBJECT}, {0, DONE_PARM} } — `include/proto.h:217; kod/include/protocol.khd:163; blakserv/sprocket.c:37`
- `BP_MESSAGE` = 32 (carries every loot refusal string) — `include/proto.h:67`
- `BP_CREATE / BP_REMOVE / BP_CHANGE` = 217 / 218 / 219 (room object appeared / vanished / changed) — `include/proto.h:191-193; user.kod:6128, 6152, 6558`
- `CLIENT_TAG_NUMBER` = 1 — the top-nibble tag on a 4-byte object id that means "a 4-byte amount follows" — `include/proto.h:283 `enum { CLIENT_TAG_NORMAL = 0, CLIENT_TAG_NUMBER = 1};``
- `GetObjId / GetObjTag` = id & 0x0fffffff / (id & 0xf0000000) >> 28 — `clientd3d/object.h:22-23`
- `SIZE_AMOUNT` = 4 — `include/proto.h:518`
- `OF_GETTABLE / OF_CONTAINER` = 0x00000010 / 0x00000020 (kod names GETTABLE_YES / CONTAINER_YES) — `include/proto.h:360-361; kod/include/blakston.khd:63,66`
- `LOOK_NO (OF_NOEXAMINE)` = 0x00000040 — what a mob corpse reports — `kod/include/blakston.khd:68; include/proto.h:362; kod/object/passive/body.kod:186-189`
- `IA_CORPSEPOINTER` = 1 (item attribute number) — `kod/include/blakston.khd:1649`
- `corpse no-steal window` = 25000 ms = 25 seconds (the iacorptr.kod header comment claims 20 seconds and is WRONG) — `kod/object/passive/body.kod:100 vs the comment at kod/object/passive/itematt/iacorptr.kod:26-28`
- `mob corpse lifetime` = 120000 ms = 120 seconds — `kod/object/passive/body.kod:88`
- `player corpse lifetime` = 600000 ms = 600 seconds — `kod/object/passive/body.kod:94`
- `PKPOINTER_TIME` = 10*60*1000 = 600000 ms (player-kill loot lock) — `kod/object/active/holder/nomoveon/battler/player.kod:70`
- `piDispose_delay (room floor GC period)` = 300000 ms base, actual interval = 300000 + Random(-5000,5000); orcpit1 = 180000, throne1 = 120000 — `kod/object/active/holder/room.kod:214, 1471-1473; orcpit1.kod:89; throne1.kod:51`
- `floor-GC threshold` = Length(plPassive) > 5 while a user is present; deletes entries past index 4*len/5 (the oldest 20%) — `kod/object/active/holder/room.kod:1496-1512`
- `drop grace period` = 60000 ms minimum remaining on the room dispose timer after a player drops an item — `kod/object/active/holder/room.kod:1785-1793`
- `pickup range` = Manhattan distance (|Δrow| + |Δcol|) > 7 is refused — `kod/object/active/holder/nomoveon/battler/player/user.kod:3620-3641`
- `INFINITE_COUNT` = -1 — `kod/include/blakston.khd:19`
- `STANDARD_RESOURCE` = 4 (default AddPacket width for BP_MESSAGE parms) — `kod/include/protocol.khd:219`
- `treasure item count` = 1 + viLevel/55 + Random(0, viDifficulty/3), Bounded to max 6, then scaled by Settings GetItemFactor/100 and Bounded to min 1; MOB_ONE_TREASURE forces exactly 1 — `kod/object/active/holder/nomoveon/battler/monster.kod:4975-4991`
- `money amount per drop` = (GetMoneyFactor * 2 * Bound(Random(level/2, 3*level/2),1,$))/100 added on top of the Money object's default piNumber of 1 — `kod/object/passive/trestype.kod:299-305; default piNumber = 1 at kod/object/item/passitem/numbitem.kod:44`
- `EQUIPMENT_DROP_PERCENT (FactionTroop)` = 20 — `kod/object/active/holder/nomoveon/battler/monster/troop.kod:33`
- `INCOMING_PACKET_THROTTLE` = the per-second packet count above which a non-immortal user is flagged bSpam and BP_SEND_OBJECT_CONTENTS is silently dropped — `kod/object/active/holder/nomoveon/battler/player/user.kod:872-886, 1011-1016`

### What two agents can exploit or must respect

- Two agents CAN both take from the same monster kill, but only after 25 seconds. Before then, only the agent whose GetTrueName matches the corpse's prPlayer_name (the killer, i.e. the `what` passed to Monster.Killed) can take any item that carries a corpse pointer. body.kod:111-123 compares NAMES, not object identity, so the claim survives across sessions and is per-character.
- The 25-second clock starts when the DeadBody is CREATED, which happens BEFORE CreateTreasure runs (monster.kod:3062 then 3108). So the window is 25 s from the moment of death, not from when the loot lands. Both agents can simply wait 25 s and then race; there is no queue and no per-item reservation.
- A two-agent protocol that avoids the wait entirely: whichever agent lands the killing blow is the sole claimant for 25 s. Alternate kills to alternate claims. There is no damage-share or first-hit tracking anywhere in the get path — Monster.KilledSomething passes only the final killer (monster.kod:3036-3051).
- The non-killer can still legally take, during the 25 s window, every item that has NO corpse pointer: Tokens, newbie signet rings, item-attributed magic weapons (all three return early from GenerateTreasure before the #corpse Create at trestype.kod:297), and the monster's own carried inventory (appended raw in monster.kod:5005-5016). If the monster has no vrDead_icon there is no corpse at all and NOTHING is claimed.
- Item.NewOwner strips IA_CORPSEPOINTER the instant anyone picks the item up (item.kod:488-499). So the killer can grab an item and immediately hand it over by dropping it — the second agent can then take it freely. Dropping is a legal laundering channel; OFFERING is not (ReqNewOwnerAttributes type=1 is checked at user.kod:5171 and 5408).
- MONEY SPLIT IS MECHANICALLY POSSIBLE and does not require alternating whole items. Send BP_REQ_GET_FROM_CONTAINER (opcode 239) with the money stack's object id OR'd with 0x10000000 in the top nibble, followed by a 4-byte little-endian amount. The server routes it to the same UserGet with #number, which calls Split. Verified end-to-end: parsecli.c:373-386 harvests the amount, user.kod:980 forwards it, user.kod:3683-3712 splits. The stock client never sends this for floor items (gameuser.c:158 only fires it from GotObjectContents), so this is a capability agents have that human players effectively do not.
- To split 100 shillings 50/50: agent A sends BP_REQ_GET_FROM_CONTAINER with amount=50; the floor object SURVIVES with piNumber=50 and keeps its original object id and its corpse pointer. Agent B then takes the remainder. If A instead requests the full 100, SubtractNumber Deletes the floor object (numbitem.kod:210-214) and its id becomes invalid — a subsequent request from B will be rejected by parsecli.c's GetObjectByID check (parsecli.c:361-368) with NO reply to B at all.
- BP_REQ_GET (113) can never take a partial stack — kod drops number_stuff for that opcode (user.kod:972). Any agent that wants partial amounts must use 239. Conversely, an agent that wants the whole stack in one packet should use 113, which is one round trip and cannot be short-changed by capacity clamping.
- STACK-MERGE HAZARD for coordinating agents: Room.NewHold merges NumberItems of the same class at the SAME row/col by default (room.kod:1734-1752). Two monsters killed on the same tile produce ONE shilling stack, the incoming Money object is Deleted, and the surviving stack keeps ITS OWN corpse pointer. So agent B's kill money can end up locked behind agent A's corpse pointer, and vice versa. Kill monsters on DIFFERENT tiles if you want independent claims. Player-death drops are exempt (#merge=FALSE, player.kod:8076).
- MERGE ALSO DEFEATS SPLIT ACCOUNTING: if A drops 50 shillings on a tile that already has shillings, A's object is Deleted and the count is folded into the resident stack. The object id A was tracking becomes invalid with no notification. Always verify via the BP_CREATE(217)/BP_REMOVE(218)/BP_CHANGE(219) stream rather than assuming a dropped stack's id persists.
- There is NO wire signal that an item is claimed. Object flags (user.kod:2431 AddPacket(4,iFlags)) contain nothing about item attributes. The only way for an agent to discover a loot lock is to attempt BP_REQ_GET and match the resulting BP_MESSAGE(32) resource id against corpsepointer_no_loot or PKpointer_no_loot. Budget for speculative-get-then-parse-refusal as the discovery mechanism.
- Refusals cost you nothing but count against the packet throttle. Note that ONE failure mode is completely silent: UserGet's `if oOldOwner = self { return; }` (user.kod:3593). If an agent double-sends a get for an item it already holds, it gets no reply — do not treat silence as success.
- DEADLINE PRESSURE: unlooted floor treasure is destroyed by the room's DisposeTimer, base interval ~300 s but the sweep also fires when the last user LEAVES the room (`if NOT pbUser_in_room` destroys everything, room.kod:1489-1494). Two agents must not both leave the room with loot still on the ground. Item.DestroyDisposable does NOT respect IA_CORPSEPOINTER (item.kod:376-385), so a reserved item can be GC'd before its reservation expires.
- With more than 5 passive objects in the room and a user present, only the oldest 20% are destroyed (room.kod:1496-1512), and plPassive is newest-first because HolderAddNode Conses to the front (holder.kod:905). Practical consequence: the FIRST thing that dies is the loot from your EARLIEST kill.
- A player corpse anywhere in the room's plPassive makes DisposeTimer return immediately (room.kod:1477-1487), suspending ALL floor cleanup. If agents want a long-lived shared stash on the floor, one of them dying in that room buys up to 600 s of GC immunity.
- BP_REQ_PUT and BP_REQ_DROP are the only ways to move items between agents without a trade dialogue. BP_REQ_PUT requires a real &Holder — a corpse will NOT work (user.kod:3899-3908, DeadBody is not a Holder), and putting into a &User is explicitly blocked and logged as an ALERT (user.kod:3891-3897). Use the floor (BP_REQ_DROP) or a StoreBox/SafeBox.
- BP_REQ_DROP's per-entry amount is positional and unlabelled: UserDropItems pops First(number_list) only for entries that IsClass &NumberItem (user.kod:3775-3781). If an agent builds the list with an amount for a non-number item, every subsequent amount shifts to the wrong item with no error. Also remember the kod list arrives REVERSED relative to the wire (parsecli.c:296-297).
- Only ONE number-tagged parameter is permitted per message; a second one triggers `eprintf("found more than one number parm")` (parsecli.c:375-377) and the amounts collide. This constrains BP_REQ_PUT to a number-tagged `what` with a plain `where`.
- BP_SEND_OBJECT_CONTENTS is spam-throttled and silently dropped when over the limit (user.kod:1013-1016), unlike most commands. An agent polling container contents in a tight loop will get silence, not an error, and must not interpret that as an empty container.
- Corpses themselves cannot be picked up or put in a bag by either agent (no OF_GETTABLE), and mob corpses cannot even be examined (LOOK_NO). They are only useful as spell targets (Animate, Defile, Portal of Life all IsClass-check &DeadBody) and as the anchor object for loot rights.
- If a MONSTER kills a player, that player's dropped inventory gets NO pointer at all (player.kod:8052-8059 sets oItemAtt = $ when the killer is not a &User). Loot from a monster-killed teammate is immediately takeable by anyone. Only player-vs-player kills attach IA_PKPOINTER, and that one lasts 10 minutes and only lets PFLAG_PKILL_ENABLE characters (or the corpse's owner) loot.

### Not determined

- Exact overlay record layout inside the "object" payload. I confirmed the count-then-records shape from DeadBody.SendOverlays (body.kod:200-222: `AddPacket(1,1)` count, then `AddPacket(4,rsc, 1,hotspot)`, then a nested translation/animation), but I did not read clientd3d ExtractOverlays to enumerate every variant. Looked in clientd3d/server.c (found the ExtractOverlays call at server.c:341) but did not open the function body.
- Blakod's comparison semantics for `$` (NIL) against an integer. UserDrop's guard is `if number <= 0` (user.kod:3802) and UserPut's is identical (user.kod:3930); when the client sends a non-number-tagged id for a NumberItem, number_list is empty so `number` is $. I could not confirm from blakserv/sendmsg.c whether NIL <= 0 evaluates TRUE (refusing the drop) or produces a type error. The intent is clearly to refuse. Same uncertainty applies to `iNumber > 0` at user.kod:3684 in the (unreachable-for-money) case where iCan_hold is INFINITE_COUNT and number is $.
- Whether a `propagate` in Blakod forwards the ORIGINAL named parameters or only the declaring message's declared ones. This matters for Money: NumberItem.Constructor declares only `number=$` (numbitem.kod:52) yet must forward `#corpse` up to Item.Constructor (item.kod:113) for money to receive a corpse pointer. I inferred forward-the-originals from the fact that trestype.kod:297 passes #corpse to every treasure class uniformly and iacorptr.kod exists to gate them, but I did not verify the PROPAGATE opcode in blakserv/sendmsg.c.
- The list of item classes whose Constructor swallows or ignores #corpse. I only read Item.Constructor and NumberItem.Constructor; some treasure classes may override Constructor without propagating and thus silently never acquire a corpse pointer. Would require reading every class named in the plTreasure tables.
- Whether any admin/DM command bypasses the corpse pointer. iacorptr.kod:57-73 and body.kod:111-123 contain no IsClass(&Admin) check, and I found only three ReqNewOwnerAttributes call sites, but I did not audit kod/object/active/holder/nomoveon/battler/player/user/dm.kod or the admin console paths for a direct NewHold that skips UserGet entirely.
- Whether ReqSomethingMoved (called in monster.kod:5029 before NewHold) can plausibly fail for treasure, which would silently Delete the loot before any player sees it. I did not read the Room implementation of ReqSomethingMoved.
- GetRarity's exact return range for the rarity(4) field in the object payload — I confirmed it is `Send(what,@GetRarity,#bSkip_Identify=bShow_All)` for &Item and literal 0 otherwise (user.kod:2433-2440) but did not read GetRarity itself. Not needed for byte alignment since the width is fixed at 4.
- The precise semantics of `if Send(what,@ReqNewOwner,#what=oSplit)` at user.kod:3695. Every other call site sends ReqNewOwner TO the item WITH the prospective owner (e.g. user.kod:3658 `Send(what,@ReqNewOwner,#what=self)`), so this line appears to have its arguments transposed — asking the floor stack whether the split object can own it. Item.ReqNewOwner (item.kod:589-592) ignores its argument entirely and returns poOwner=$ OR ReqLeaveHold, so it happens to return TRUE in practice and the split succeeds. I flag it as a probable latent bug rather than a rule, and did not test it.


---

## Kill credit and shared combat (Meridian 59, C:/code/meridian59)

Kill credit is PER-PLAYER and NOT diluted. When a player lands a killing blow, player.kod:4827 sends @SomethingKilled to the killer's room; room.kod:745 handles it then `propagate`s into holder.kod:669-680, which forwards @SomethingKilled to EVERY object in plActive (all players and monsters in the room). Each player's own handler (player.kod:7705) independently asks "is the dead thing my poKill_target?" and, if so, runs its own @AdvancementCheck with killing_blow = (what = self). So two players who both damaged the monster and are both in the room both advance: the killer gets 3 points if it also took damage (else 2), the non-killer gets 2 unconditionally. There is NO attacker/damage list on the monster — the only per-attacker state is a single scalar piHatred (monster.kod:314) plus poTarget, so there is no threat table and no proportional-damage loot. Treasure is a plain floor drop at the monster's tile (monster.kod:5030), but every generated item carries an IA_CORPSEPOINTER attribute bound to the corpse (item.kod:114-127), and DeadBody.CanGetMe (body.kod:111-123) refuses anyone whose TrueName ≠ the killer's for exactly 25 seconds (body.kod:100). Aggro is not stealable while a monster is in STATE_ATTACK — brain.kod:252-253 returns unconditionally in that case — so one agent can hold a monster indefinitely while another free-hits it, and Bait (SID_BAIT) / Mark of Dishonor (SID_MARK_OF_DISHONOR) call @TargetSwitch directly to bypass even that. Respawn is a ~4s-per-monster room timer that only runs while a player is present, with a 180s lockout on the initial batch after a room is cleared and vacated.

### Wire formats

**BP_MESSAGE (32) — server->client**

```
opcode(1) | resource_id(4) | then 0..8 parameters, each written with AddPacket(type_n, parm_n) where type_n defaults to STANDARD_RESOURCE (width 4). Parameters stop as soon as the first $ parm is reached — there is NO count field, so the number of trailing 4-byte fields is determined entirely by the resource's own %s/%q format string. A parm passed with type=STRING_RESOURCE (width 6) is 2-byte length + raw bytes instead of a 4-byte id.
```

*kod/object/active/holder/nomoveon/battler/player/user.kod:MsgSendUser (AddPacket(1,BP_MESSAGE,4,message_rsc) then per-parm AddPacket(type_n,parm_n)); parsed at clientd3d/server.c:852-869 HandleStringMessage -> Extract(&ptr,&resource_id,SIZE_ID) then CheckServerMessage(); opcode number kod/include/protocol.khd:18 and include/proto.h:67*

This is the ONLY observable channel for kill-credit events. Resource ids in this build (kod/kodbase.txt): Lm_party_killed_monster=23469 ("~B%s%s has valiantly slain %s%s!", 4 parms — the shared-credit signal), player_killed_something=23555 (2 parms, generic killing blow), player_improve_maxhealth=23532 (0 parms, HP gain fired), player_spits=23534 (0 parms, kill was too easy — gain 0), player_advancement_cap_hit_1=23736 (0 parms, at ADVANCEMENT_LIMIT), corpsepointer_no_loot=28660 (3 parms, loot lock refusal). CRITICAL: the killing-blow message is stroke-overridable, so an agent must match a SET of ids, not one: Thrust_player_killed_something=28418, punch_=28433, kick_=28441, TouchOfFlame_=28007, HolyTouch_=28019, IcyFingers_=28031, zap_=28044, AcidTouch_=28055 (kod/object/passive/skill/stroke.kod:302-315). If the victim's @SayDyingWords returns TRUE (default FALSE at kod/object/active/holder/nomoveon/battler.kod:165-168) NO kill message is sent at all. Resource ids are build-generated; re-read kodbase.txt per build.

**BP_CREATE (217) — server->client**

```
opcode(1) | object (as already defined: id(4) [amount(4) if top nibble==1] iconRsc(4) nameRsc(4) flags(4) rarity(4) dLighting) | x(2) = row*FINENESS+fine_row | y(2) = col*FINENESS+fine_col | angle(2) | paletteTranslation | animation | overlays
```

*kod send: kod/object/active/holder/nomoveon/battler/player/user.kod:6113-6138 SomethingEntered — AddPacket(1,BP_CREATE); Send(self,@ToCliObject,#what=what); AddPacket(2,First(lPos)*FINENESS+Nth(lPos,3), 2,Nth(lPos,2)*FINENESS+Nth(lPos,4), 2,Send(what,@GetAngle)); Send(what,@SendMoveAnimation); Send(what,@SendMoveOverlays). C parse: clientd3d/server.c:728-748 HandleCreate -> ExtractNewRoomObject at clientd3d/server.c:384-405. Opcode number kod/include/protocol.khd:141*

This is how an agent sees treasure hit the floor and the DeadBody appear. The trailing block after angle is SendMoveAnimation/SendMoveOverlays, NOT SendAnimation/SendOverlays. For plain items object.kod:462-468 SendMoveAnimation emits AddPacket(1,ANIMATE_NONE,2,1) = 3 bytes: ExtractPaletteTranslation peeks 1 byte, sees ANIMATE_NONE=1 (not 9/10) and rewinds, then ExtractAnimation consumes 1+2. object.kod:471-477 SendMoveOverlays emits AddPacket(1,0) = a single zero overlay count. Many monsters override SendMoveAnimation (e.g. kod/object/active/holder/nomoveon/battler/monster/ant.kod:114) so the block width varies — ANIMATE_CYCLE=2 adds 8, ANIMATE_ONCE=3 adds 10 (clientd3d/server.c:222-261, include/proto.h:290-292). Desync hazard: item.kod:634-640 SendAnimation (used by BP_ROOM_CONTENTS/BP_CHANGE paths) DOES prefix AddPacket(1,ANIMATE_TRANSLATION,1,palette) when the item has a non-zero palette, so the same item is 2 bytes wider there.

**BP_REMOVE (218) — server->client**

```
opcode(1) | obj_id(4)
```

*kod/object/active/holder/nomoveon/battler/player/user.kod:6140-6156 SomethingLeft — AddPacket(1,BP_REMOVE,4,what); parsed at clientd3d/server.c:750-765 HandleRemove which hard-requires len == 1*SIZE_ID. Opcode number kod/include/protocol.khd:142*

Fires when the monster object is deleted at the end of monster.kod:3110 Send(self,@Delete). Ordering an agent can rely on: the advancement broadcast (player.kod:4827) happens BEFORE Send(what,@Killed) at player.kod:4927, so BP_MESSAGE credit messages precede the BP_CREATE for the corpse/loot and the BP_REMOVE for the monster.

**BP_REQ_LOOK (116) — client->server**

```
opcode(1) | obj_id(4)
```

*dispatch at kod/object/active/holder/nomoveon/battler/player/user.kod:1042 (if liClient_cmd = BP_REQ_LOOK -> UserLook at :4224); opcode number kod/include/protocol.khd:70*

Looking at a DeadBody is the ONLY way to read who owns the 25s loot lock: body.kod:167-175 ShowDesc emits AddPacket(4,vrDesc, 4,prMonster_name, STRING_RESOURCE,prPlayer_name) with deadbody_desc_rsc=26042 "This is a dead, decomposing %s, slain by %q." — prPlayer_name is Send(killer,@GetTrueName) from monster.kod:3056-3070 CreateDeadBody. Note the third field is width 6 (STRING_RESOURCE): 2-byte length then bytes, NOT a 4-byte id. UserLook also triggers NotifyMonstersOfPresence (user.kod:4230) and therefore FirstMove aggro.

**BP_REQ_ATTACK (103) — client->server**

```
opcode(1) | type(1) | obj_id(4)
```

*dispatch at kod/object/active/holder/nomoveon/battler/player/user.kod:1104 (if liClient_cmd = BP_REQ_ATTACK -> UserAttack(type=..., what=...) at :4663); opcode number kod/include/protocol.khd:57. Authoritative widths in blakserv/sprocket.c client_def_table.*

This is the message that sets poKill_target. UserAttack calls NotifyMonstersOfPresence FIRST (user.kod:4667-4672), i.e. an agent's very first attack in a room fires room.kod:3668 FirstMove and re-aims up to 5 monsters at it, before the swing resolves. Widths above are inferred from the kod handler signature — verify against blakserv/sprocket.c client_def_table before relying on them.

### Rules, in the order the server checks them

| | rule | where |
|---|---|---|
| **silent** | Advancement is per-player and evaluated independently for every player in the killer's room. The room broadcast reaches every object in plActive; each player runs its OWN AdvancementCheck. Nothing divides, splits, or caps the reward by party size. | `kod/object/active/holder/nomoveon/battler/player.kod:4827 Send(poOwner,@SomethingKilled,#what=self,#victim=what) -> kod/object/active/holder/room.kod:745-758 (handles DEATH_LINK then `propagate`) -> kod/object/active/holder.kod:669-680 `for i in plActive { each_obj = Send(self,@HolderExtractObject,#data=i); Send(each_obj,@SomethingKilled,#what=what,#victim=victim); }` -> kod/object/active/holder/nomoveon/battler/player.kod:7705-7722` |
| **silent** | Gate 1 for any credit: the dead thing must equal YOUR poKill_target. `if victim = poKill_target AND IsClass(victim,&Battler)`. If not, you get nothing and your gain flags are NOT even reset. | `kod/object/active/holder/nomoveon/battler/player.kod:7707` |
| **silent** | killing_blow is TRUE only for the player equal to `what` (the killer) in the broadcast; every other qualifying player gets killing_blow=FALSE. Both then get AdvancementCheck. | `kod/object/active/holder/nomoveon/battler/player.kod:7709-7717 `if what = self { Send(self,@AdvancementCheck,#what=victim,#killing_blow=TRUE); } else { Send(self,@AdvancementCheck,#what=victim,#killing_blow=FALSE); }`` |
| message | Gate 2: AdvancementCheck refuses outright if the victim returns FALSE for @CanPlayerAdvanceOnMe (illusions), or the room has ROOM_SAFE_DEATH, or it is an arena without ArenaRealDeath. | `kod/object/active/holder/nomoveon/battler/player.kod:7746-7752; monster.kod:5236-5239 CanPlayerAdvanceOnMe returns (NOT pbIllusion)` |
| **silent** | Gate 3: you must have PFLAG_DID_DAMAGE AND poKill_target = what. Pure tanking with zero damage dealt earns zero, even though being hit sets poKill_target for you. | `kod/object/active/holder/nomoveon/battler/player.kod:7764-7765 `if Send(self,@CheckPlayerFlag,#flag=PFLAG_DID_DAMAGE) AND poKill_target = what`` |
| **silent** | Reward table, evaluated per player: if monster_level > your piBase_Max_health then gain=3 & roll=TRUE if (killing_blow AND PFLAG_TOOK_DAMAGE), else gain=2 & roll=TRUE. So a non-killer damager always gets 2; the killer gets 3 only if it also took damage. | `kod/object/active/holder/nomoveon/battler/player.kod:7767-7783` |
| message | If monster_level <= your piBase_Max_health: gain=1 (no roll) ONLY if (monster_level+5) > piBase_Max_health AND IsClass(what,&monster) AND killing_blow AND PFLAG_TOOK_DAMAGE. A non-killer gets exactly 0 in this near-level band. Otherwise a 10% chance of the player_spits taunt message. | `kod/object/active/holder/nomoveon/battler/player.kod:7785-7801` |
| **silent** | Bonuses/penalties applied after the table: +1 if piBase_Max_health < PKILL_ENABLE_HP (30); gain halved and roll cancelled if piMax_health > piBase_Max_health*2 AND monster_level < piMax_health (anti-buff-cheese); then gain *= bound(GetHPGainMultiplier(),1,100) which defaults to 1. | `kod/object/active/holder/nomoveon/battler/player.kod:7803-7818; kod/include/blakston.khd:2094 PKILL_ENABLE_HP=30; kod/util/settings.kod:67 piHPGainMultiplier=1` |
| **silent** | gain is always accumulated into piGain_chance even when roll=FALSE; the actual HP gain only rolls when roll=TRUE. rand=random(1,GetHighMark()) must be < GetGainChance() + bound((monster_level-piBase_Max_health)/5,0,10), and piBase_Max_health must be < 101 + GetStamina(). On success piGain_chance resets to -(piBase_Max_health/2), further reduced above 30 HP. | `kod/object/active/holder/nomoveon/battler/player.kod:7816-7856; GetHighMark at :7895-7902 = (index+1)*index where index = piBase_Max_health*(100-stamina)/100` |
| **silent** | ResetGainFlags clears poKill_target, PFLAG_DID_DAMAGE, PFLAG_TOOK_DAMAGE and PFLAG_DODGED. It runs (a) after a successful credited kill, and (b) on ANY target switch inside TryAttack. Switching your melee/stroke target therefore destroys all accumulated credit on the previous monster. | `kod/object/active/holder/nomoveon/battler/player.kod:7725-7733; and kod/object/active/holder/nomoveon/battler/player.kod:4063-4067 `if poKill_target <> what { Send(self,@ResetGainFlags); poKill_target = what; }` inside TryAttack (:3960)` |
| **silent** | Attack SPELLS do NOT go through TryAttack's reset — atakspel.kod calls @SetKillTarget directly and force-sets PFLAG_DID_DAMAGE, leaving PFLAG_TOOK_DAMAGE from the PREVIOUS target intact. A caster who took damage from monster A and then nukes monster B is credited as if it took damage from B (gain 3 instead of 2). | `kod/object/passive/spell/atakspel.kod:128-131 `Send(who,@SetKillTarget,#target=oTarget); Send(who,@SetPlayerFlag,#flag=PFLAG_DID_DAMAGE,#value=TRUE);` vs player.kod:2633-2638 SetKillTarget which only assigns poKill_target. Same pattern in illwound.kod:113-114 and firewand.kod:134-135.` |
| **silent** | PFLAG_DID_DAMAGE is set in DidDamage when amount > 0 (any non-fatal hit), and unconditionally at the top of KilledSomething (so the killing blow always counts as damage even though DidDamage is skipped on a kill). | `kod/object/active/holder/nomoveon/battler/player.kod:4677 DidDamage -> :4704-4707 `if amount > 0 { Send(self,@SetPlayerFlag,#flag=PFLAG_DID_DAMAGE,#value=TRUE); }`; :4801 in KilledSomething; battler.kod:344-353 chooses KilledSomething XOR DidDamage` |
| **silent** | PFLAG_DID_DAMAGE is also set by damage sources you did not swing: wall of fire, wall of lightning, poison fog, firewand, vampiric wand, attack spells, illusionary wounds, bramble. So DoT/wall damage alone qualifies you for credit if poKill_target also matches. | `kod/object/active/wallelem/wallfire.kod:119,127; wallltng.kod:94,102; poisfogc.kod:95; firewand.kod:135; vampwand.kod:127; atakspel.kod:131; illwound.kod:114; monster/BRAMBLE.kod:246` |
| **silent** | PFLAG_TOOK_DAMAGE is set in AssessDamage only when the hit was NON-FATAL and `what = poKill_target AND damage > 0`. If you have no target yet, poKill_target is first assigned to your attacker, so a first hit does set it; but if you are already targeting monster A and monster B hits you, TOOK_DAMAGE is NOT set. | `kod/object/active/holder/nomoveon/battler/player.kod:4556 AssessDamage -> :4632-4646 (fatal case returns $ before the flag block) -> :4650-4659 `if poKill_target = $ { poKill_target = what; } if what = poKill_target AND damage > 0 { Send(self,@SetPlayerFlag,#flag=PFLAG_TOOK_DAMAGE,#value=TRUE); }`` |
| **silent** | PFLAG_DODGED is set on the defender by battler.kod when an attack misses, and is consumed at the very end of AdvancementCheck to grant one ImproveAbility roll on Dodge (or 30% Parry with a non-ranged weapon, or 30% Block with a shield). This fires even when gain was 0. | `kod/object/active/holder/nomoveon/battler.kod:1011 `Send(what,@SetPlayerFlag,#flag=PFLAG_DODGED,#value=TRUE);` and kod/object/active/holder/nomoveon/battler/player.kod:7860-7884` |
| **silent** | There is NO attacker list and NO damage accounting on the monster. The only per-target state is scalar poTarget plus scalar piHatred, incremented by exactly +1 per hit and ONLY when the hitter is the current poTarget. Hits from anyone else contribute nothing to hate. | `kod/object/active/holder/nomoveon/battler/monster.kod:301 poTarget=$, :314 piHatred=0; monster.kod:1564-1569 `if what = poTarget { piHatred = piHatred + 1; }` inside AssessDamage (:1529). Full property list of monster.kod has no attacker list: only plWantedItems, plOffer_items, plFor_sale, plEnchantments, plActiveQuestNodes, plSpamList (monster.kod:278-334).` |
| **silent** | A monster in STATE_ATTACK never switches target in response to being attacked. brain.kod SomethingAttacked handles STATE_WAIT|STATE_MOVE and STATE_CHASE, then hits `if state & STATE_ATTACK { return; }` and does nothing. Movement does not clear it: VSTATE_VALIDITY_MASK = 0x0FFFF preserves STATE_ATTACK = 0x2. | `kod/object/passive/brain.kod:190-255, refusal at :252-253; kod/object/active/holder/nomoveon/battler/monster.kod:866-872 SomethingMoved `piState = (piState & VSTATE_VALIDITY_MASK)`; kod/include/blakston.khd:1441 STATE_ATTACK=0x2, :1458 VSTATE_VALIDITY_MASK=0x0FFFF` |
| **silent** | Attacks by a third party are only even considered 40% of the time. In brain.kod SomethingAttacked, if the victim is not the mob itself, `if random(1,10) < 6 or (GetBehavior & AI_FIGHT_MURDERERS) { return; }` — so a bystander's attack on someone else is ignored 60% of the time outright, and always ignored for guard-type mobs. | `kod/object/passive/brain.kod:203-210` |
| **silent** | Even when a switch is considered, GetHatred applies -10 for already having a target and a further -15 if that target is targeting the mob back. AI_FIGHT_SINGLEMINDED mobs (and Revenants) never switch at all. Different rooms => return 0. Invisible => -50; shadowform => -25 (both waived if the mob itself is the victim). | `kod/object/passive/brain.kod:636-720, specifically :655-669 (singleminded / -10 / -15), :702 (different room), :692-700 (invis/shadow); AttemptTargetSwitch rejects Revenants at :935` |
| **silent** | AttemptTargetSwitch compares the new candidate's computed iHatred against `oldHatred = send(mob,@GetHatred,#what=what)` — but monster.kod GetHatred() takes NO arguments and just returns the scalar piHatred. The #what= is silently discarded. Switching therefore requires beating the CURRENT target's accumulated hate, which is (initial iHatred at TargetSwitch time) + 1 per landed hit. | `kod/object/passive/brain.kod:947-956 vs kod/object/active/holder/nomoveon/battler/monster.kod:5538-5541 `GetHatred() { return piHatred; }`` |
| **silent** | EnterStateAttack(target=$, actnow=TRUE) IGNORES its target parameter entirely — it only sets the state bit and the timer. poTarget is assigned ONLY by @TargetSwitch (monster.kod:5562) or by the follow-master path (monster.kod:5486). Calling EnterStateAttack cannot retarget a monster. | `kod/object/active/holder/nomoveon/battler/monster.kod:763-777 (body never reads `target`); :5543-5576 TargetSwitch` |
| **silent** | Every state transition to LIMBO / WAIT / MOVE clears poTarget AND zeroes piHatred. A monster that loses reach and drops out of chase forgets all hate, so accumulated aggro is not durable across a break in combat. | `kod/object/active/holder/nomoveon/battler/monster.kod:685-703 (EnterStateLimbo), :705-731 (EnterStateWait), :733-760 (EnterStateMove) — each does poTarget=$; piHatred=0;` |
| **silent** | A player who has entered a room but not yet acted is INVISIBLE to monster aggro. PFLAG_MOVED_SINCE_ENTRY is cleared on room entry; only NotifyMonstersOfPresence (called from the first move, turn, get, drop, put, say, saygroup, look, activate, mail, use, unuse, ATTACK, cast, or action) fires room.kod FirstMove. | `kod/object/active/holder/nomoveon/battler/player.kod:1445 and :1871 clear the flag; kod/object/active/holder/nomoveon/battler/player/user.kod:3114-3131 NotifyMonstersOfPresence -> Send(poOwner,@FirstMove,...); 17 call sites at user.kod:3103,3167,3587,3772,3890,4056,4175,4230,4473,4509,4589,4616,4640,4671,4766,4868` |
| **silent** | FirstMove is an aggro bomb that BYPASSES the STATE_ATTACK protection. room.kod scores every monster in plActive with GetHatred(event=6) and then calls TargetSwitchMob on the top five, which calls AttemptTargetSwitch with event=7 (TS_ENTRY_APPROVED, +20 hatred) — a path with no state gate. It also calls ResetMonsterChasers on the arriving player first. | `kod/object/active/holder/room.kod:3668-3767 FirstMove, :3769-3798 TargetSwitchMob (`AttemptTargetSwitch,#event=7`); brain.kod:22 TS_ENTRY_APPROVED=7, brain.kod:890-893 `if (event = TS_ENTRY_APPROVED) { iHatred = iHatred + 20; }`` |
| **silent** | Hatred is REDUCED for a player who already has many monsters on them: `iHatred = iHatred - (GetMonsterChasers * piChaser_factor)/100`. This is skipped when the event is TS_FIGHT_ME_VICTIM (i.e. you personally hit the mob) unless the server sets AlwaysCheckMonsterChasers (default FALSE). piMonsterChasers is the SUM of the levels of monsters currently targeting you. | `kod/object/passive/brain.kod:900-911; player.kod:942 piMonsterChasers=0, :12218-12242 Reset/Add/Subtract/GetMonsterChasers; monster.kod:5554-5566 TargetSwitch maintains it; kod/util/settings.kod:142 pbAlwaysCheckMonsterChasers=FALSE, :356-359` |
| **silent** | Treasure generation receives #who = the killing-blow player only. `who` gates: token realization (20% base, requires PlayerIsIntriguing and an open token in the room), the newbie signet ring, and the magic item-attribute weapon roll. Nothing about the second damager influences the drop table. | `kod/object/active/holder/nomoveon/battler/monster.kod:3108 Send(self,@CreateTreasure,#who=what,#corpse=oBody); monster.kod:4984-4986 GenerateTreasure(#who=who); kod/object/passive/trestype.kod:223-311, token branch :228-243, signet branch :245-263, itematt branch :270-283; kod/include/blakston.khd:2339 TOKEN_GENERATION_CHANCE=20` |
| **silent** | Item COUNT and money are set by the monster's own viLevel/viDifficulty class constants and server settings, never by the number of players: iNumberItems = 1 + (viLevel/55) + Random(0,viDifficulty/3), bounded to 6, then *ItemFactor/100, floored at 1 (or exactly 1 if MOB_ONE_TREASURE). | `kod/object/active/holder/nomoveon/battler/monster.kod:4962-4977; money at kod/object/passive/trestype.kod:298-304` |
| **silent** | Loot is a FLOOR drop at the monster's tile, plus the monster's entire plActive and plPassive inventory. There is no per-player loot instancing and no ownership on inventory drops. Items that fail ReqNewHold/ReqSomethingMoved are DELETED, not relocated. | `kod/object/active/holder/nomoveon/battler/monster.kod:5013-5023 (inventory cons'd onto the list), :5026-5041 (drop loop, else Send(oTreasure,@Delete))` |
| message | Generated treasure IS loot-locked to the killer for 25 seconds. Create(...,#corpse=corpse) attaches IA_CORPSEPOINTER; on pickup ReqNewOwnerAttributes asks the attribute's CanGetAffectedItem, which asks DeadBody.CanGetMe, which returns TRUE only if ptNoSteal has expired or GetTrueName matches prPlayer_name (= Send(killer,@GetTrueName)). | `kod/object/passive/trestype.kod:292-298 Create(First(lItem_info),#corpse=corpse); kod/object/item.kod:114-127 Constructor attaches IA_CORPSEPOINTER; kod/object/item.kod:611-632 ReqNewOwnerAttributes; kod/object/passive/itematt/iacorptr.kod:57-72; kod/object/passive/body.kod:99-100 ptNoSteal=CreateTimer(self,@NoStealTimer,25000), :111-123 CanGetMe; monster.kod:3056-3070 CreateDeadBody #playername=Send(killer,@GetTrueName)` |
| **silent** | The 25s loot lock has real holes: NO corpse pointer is attached if the killer was a Monster, if the corpse is an OrcPitBossBody, if the monster has vrDead_icon = $ (no corpse object at all), on the monster's own dropped INVENTORY, or on the special early-return drops (token, signet ring, item-attribute weapon). Those are free-for-all immediately. | `kod/object/passive/trestype.kod:292-296 `if isClass(who,&Monster) or isClass(corpse,&OrcPitBossBody) { oObj = Create(First(lItem_info)); } else { oObj = Create(First(lItem_info),#corpse=corpse); }`; early returns at trestype.kod:239-242 (token), :256-262 (signet), :275-282 (itematt); monster.kod:3058-3066 (oBody stays $ if vrDead_icon = $); monster.kod:5013-5023 (inventory)` |
| **silent** | The corpse pointer also self-clears early: item.kod NewOwner strips IA_CORPSEPOINTER as soon as anyone legitimately picks the item up, and ObjectCorpseFading strips it when the corpse decomposes (mob corpses: 120000 ms). | `kod/object/item.kod:488-498; kod/object/item.kod:909-931; kod/object/passive/body.kod:83-88 ptDelete = CreateTimer(self,@DeleteTimerMessage,120000) for mobs` |
| **silent** | QUEST credit goes to the killing-blow player ONLY, with no shared-credit path. Send(...@MonsterKilled,#killing_player=what) and the quest node matches `if killing_player = oQuester`. | `kod/object/active/holder/nomoveon/battler/monster.kod:3104-3106; kod/util/questengine.kod:7099-7108; kod/object/passive/questnode.kod:1527-1548 (`if killing_player = oQuester`)` |
| **silent** | Skill and spell advancement is entirely per-swing/per-cast and completely independent of kill credit. ImproveAbility is called from the stroke/spell path, requires only HasSkill, CheckAdvancementPoints, target CanPlayerAdvanceOnMe, and a non-safe-death room. | `kod/object/passive/skill.kod:283 and :294-375; kod/object/passive/spell.kod:1398 and :1604-1640` |
| **silent** | Weapon proficiency swings are likewise per-player: every TryAttack increments piWeaponSwings by 1 provided the target CanPlayerAdvanceOnMe and there is line of sight (or a 1-in-25 pity roll). Every SWINGS_PER_IMPROVE_CHECK = 75 swings grants +1000 to piWeaponInfo (a swing-group bonus). | `kod/object/active/holder/nomoveon/battler/player.kod:4097-4108 (LineOfSight or random(1,25)=1 -> SwingWeapon), :4736-4766 SwingWeapon, :100 SWINGS_PER_IMPROVE_CHECK=75` |
| message | ADVANCEMENT_LIMIT = 10 is an anti-bot cap on SKILL/SPELL improvement ONLY. CheckAdvancementPoints is consulted by skill.kod:322 and spell.kod:1634 and by AddToSchools (halves credit), but AdvancementCheck (HP gain) never calls it — HP gain is uncapped by advancement points. Points decay to 0 on the AdvancementTimer (900000-1320000 ms) and drop by 2 on every room change. | `kod/object/active/holder/nomoveon/battler/player.kod:68 ADVANCEMENT_LIMIT=10, :7630-7645 AddAdvancementPoints, :7647-7677 CheckAdvancementPoints, :7679-7702 AdvancementTimer, :66-67 ADVANCE_TIMER_MIN/MAX=900000/1320000, :1465 `piAdvancement_points = bound((piAdvancement_points - 2),0,$)` in NewOwner; call sites skill.kod:322, spell.kod:1634, player.kod:6271` |
| **silent** | Respawn: MonsterRoom runs one spawn attempt per timer tick. iWaitTime = (piGen_Time * GetSpawnRate()/100) / iNumberOfPlayers, but because vbScaleSpawnRateWithPlayers is FALSE and never overridden anywhere in the tree, iNumberOfPlayers is FORCED to 5. With defaults piGen_Time=20000 and piSpawnRate=100 that is 4000 ms per attempt, regardless of how many players are present. | `kod/object/active/holder/room/monsroom.kod:88-108 GetMonsterGenTime, :22 vbScaleSpawnRateWithPlayers=FALSE (only other reference is :100), :26 piGen_Time=20000; kod/util/settings.kod:41 piSpawnRate=100 (80 on server 101, 85 on server 102 per :177,:187). No room in kod/object/active/holder/room/ overrides piGen_Time.` |
| **silent** | Each spawn attempt: fails if piMonster_count >= piMonster_count_max, or pbGenerateMonsters is FALSE, or Random(1,100) > piGen_percent (default 100, so never). Class picked by weighted roll over plMonsters; position from a random element of plGenerators, or a uniformly random tile if plGenerators is $. If ReqNewHold/ReqSomethingMoved fail the new monster is deleted. | `kod/object/active/holder/room/monsroom.kod:132-170 TryCreateMonster, :177-231 GenerateMonster, :233-236 IsMonsterCountBelowMax, :50 piMonster_count_max=10 default (rooms override, e.g. barlsew.kod:53 = 25), :47 piGen_percent=100` |
| message | The generator timer only exists while a player is in the room: FirstUserEntered creates ptGen, LastUserLeft deletes it. An empty room never spawns. | `kod/object/active/holder/room/monsroom.kod:265-323 FirstUserEntered (CreateTimer at :303 and :318), :339-362 LastUserLeft (DeleteTimer at :326-330)` |
| **silent** | Anti-farm lockout: FirstUserEntered spawns the initial batch of Random(piInit_count_min,piInit_count_max) = 1..5 monsters ONLY if no non-MOB_NOFIGHT monster is already in the room AND pbOkay_To_Load. If the last player leaves a room with piMonster_count = 0, pbOkay_To_Load goes FALSE for piReload_Wait_Time * SpawnRate/100 = 180000 ms. The per-4s gen timer still runs on re-entry; only the burst is suppressed. | `kod/object/active/holder/room/monsroom.kod:288-306 (bFound OR NOT pbOkay_To_Load -> create timer and propagate, skipping the batch), :335-341 `iWaitTime = (piReload_Wait_Time * GetSpawnRate())/100; ptOkay_To_Load = CreateTimer(self,@OkaytoLoadTimer,iWaitTime); pbOkay_To_Load = FALSE;`, :33 piReload_Wait_Time=180000, :320-321 comment "Endless exp boosting"` |
| **silent** | NOTHING scales monsters to party size. viLevel and viDifficulty are classvars fixed per monster class; monster attack/defense/damage are computed purely from them. There is no group XP dilution, no shared reward pool, and no party object at all. | `kod/object/active/holder/nomoveon/battler/monster.kod:226-230 (viLevel=25, viDifficulty=0 as classvars), :1440 iAttack=(3*viLevel)+(60*viDifficulty), :1463 iDefense, :1494 iDamage; GetLevel() just returns viLevel. No plGroup/party mechanic exists in player.kod (only an unrelated political-faction string at :643).` |
| **silent** | FRIENDLY FIRE IS REAL for area effects and bypasses AllowPlayerAttack. Earthquake with no explicit target list hits every Battler in the room except the caster — including other players — by calling AssessDamage directly, with no AllowPlayerAttack / IsPKAllowed / SafePlayerAttack check anywhere in the file. | `kod/object/passive/spell/earthqua.kod:246-252 `if lTargets = $ AND IsClass(each_obj,&Battler) AND each_obj <> who { lFinalTargets = cons(each_obj, lFinalTargets); }`, damage at :282-296. grep for AllowPlayerAttack/IsLikelyVictim/SafePlayerAttack/IsPKAllowed in earthqua.kod returns nothing.` |
| **silent** | Wall elements (fire, lightning, poison fog) damage ANY Battler that walks into range, excluding only the caster and only when vbCanAffectCaster is FALSE. The only gates are ROOM_NO_COMBAT (players) / ROOM_NO_MOB_COMBAT (monsters) and a per-cycle already-affected list. | `kod/object/active/wallelem.kod:100-129 SomethingMoved, :132-160 CheckForEffect; kod/object/active/wallelem/wallfire.kod:77-110 DoEffect calls AssessDamage unconditionally` |
| **silent** | Killing another player (or being credited for it) sets PFLAG_MURDERER, increments piKill_count/piKill_count_decay, applies negative karma, and rolls a Revenant haunt. Only the killing-blow player is checked, and only if the room is not SafePlayerAttack and the victim held no Token. | `kod/object/active/holder/nomoveon/battler/player.kod:4837-4918; note the acknowledged bug comment at :4876-4879 that the faction check is skipped for monster kills scored with only the killing blow` |

### Constants

- `ADVANCEMENT_LIMIT` = 10 — `kod/object/active/holder/nomoveon/battler/player.kod:68`
- `ADVANCE_TIMER_MIN / ADVANCE_TIMER_MAX` = 900000 / 1320000 ms (15-22 min advancement-point reset window) — `kod/object/active/holder/nomoveon/battler/player.kod:66-67`
- `SWINGS_PER_IMPROVE_CHECK` = 75 — `kod/object/active/holder/nomoveon/battler/player.kod:100`
- `PKILL_ENABLE_HP` = 30 (below this base max health you get +1 gain on every credited kill) — `kod/include/blakston.khd:2094; used at player.kod:7803-7806`
- `PFLAG_DID_DAMAGE` = 0x000010 — `kod/include/blakston.khd:2104`
- `PFLAG_TOOK_DAMAGE` = 0x000020 — `kod/include/blakston.khd:2105`
- `PFLAG_DODGED` = 0x000040 — `kod/include/blakston.khd:2106`
- `PFLAG_MOVED_SINCE_ENTRY` = 0x400000 (clear = invisible to monster aggro) — `kod/include/blakston.khd:2125`
- `STATE_LIMBO / STATE_ATTACK / STATE_CHASE / STATE_WAIT / STATE_MOVE` = 0x00001 / 0x00002 / 0x00004 / 0x00008 / 0x00010 — `kod/include/blakston.khd:1440-1444`
- `VSTATE_VALIDITY_MASK` = 0x0FFFF (movement clears only the validity bits 0x10000/0x20000; STATE_ATTACK survives) — `kod/include/blakston.khd:1456-1458`
- `TS_MOVE / TS_FIGHT_ME_VICTIM / TS_FIGHT_ME_AGGRESSOR / TS_FIGHT / TS_MURDER / TS_ENTRY / TS_ENTRY_APPROVED` = 1 / 2 / 3 / 4 / 5 / 6 / 7 — `kod/object/passive/brain.kod:16-22`
- `Hatred modifiers` = already have a target -10; that target targets me a further -15; TS_MURDER +75; TS_ENTRY with no target +5; TS_ENTRY_APPROVED +20; invisible -50; shadowform -25; monster level bonus +Bound(level,1,100)/5; player bonus +(Bound(MaxHealth-20,0,150)*piPlayer_factor)/100; chasers penalty -(GetMonsterChasers*piChaser_factor)/100; AI_FIGHT_HYPERAGGRESSIVE +piHyperAggressive_factor — `kod/object/passive/brain.kod:655-669, 692-700, 706, 884-916`
- `DeadBody loot lock (ptNoSteal)` = 25000 ms — `kod/object/passive/body.kod:99-100`
- `DeadBody decay` = 120000 ms for mobs, 600000 ms for players — `kod/object/passive/body.kod:83-92`
- `piGen_Time (MonsterRoom base spawn interval)` = 20000 ms; effective = piGen_Time * SpawnRate/100 / 5 = 4000 ms at default settings — `kod/object/active/holder/room/monsroom.kod:26 and :88-108`
- `piReload_Wait_Time (post-clear lockout on the initial batch)` = 180000 ms, scaled by SpawnRate/100 — `kod/object/active/holder/room/monsroom.kod:33 and :335-341`
- `piInit_count_min / piInit_count_max` = 1 / 5 (initial batch size, capped by Length(plGenerators)) — `kod/object/active/holder/room/monsroom.kod:39-45, :308-312`
- `piMonster_count_max` = 10 default; rooms override (e.g. barlsew 25, a5 15, a6/c6/d5 12) — `kod/object/active/holder/room/monsroom.kod:50; kod/object/active/holder/room/monsroom/barlsew.kod:53; a5.kod:55; a6.kod:52`
- `piGen_percent` = 100 (spawn attempt never randomly aborts by default) — `kod/object/active/holder/room/monsroom.kod:47`
- `piSpawnRate / piItemFactor / piMoneyFactor / piMagicItemModifier / piHPGainMultiplier / piAdvancementRate` = 100 / 100 / 100 / 100 / 1 / 100 by default; server 101 => 80/125/120/80 and rate 125; server 102 => 85/175/100/100 and rate 190 — `kod/util/settings.kod:31-67 and :168-190`
- `TOKEN_GENERATION_CHANCE` = 20 (percent, on the killing-blow player only) — `kod/include/blakston.khd:2339; kod/object/passive/trestype.kod:228-233`
- `viLevel / viDifficulty` = classvars, default 25 / 0; viLevel documented range 25-200 (>=150 boss), viDifficulty 1-9 — `kod/object/active/holder/nomoveon/battler/monster.kod:226-230`
- `Bait (SID_BAIT)` = 115, Riija level 2, 8 mana, 2000 ms cast, reagents WebMoss + FireSand — `kod/include/blakston.khd:1940; kod/object/passive/spell/bait.kod:38-45, :53-59`
- `Mark of Dishonor (SID_MARK_OF_DISHONOR)` = 44, Shalille level 4, 12 mana — `kod/include/blakston.khd:1878; kod/object/passive/spell/dishonor.kod:48-51`
- `Seduce (SID_SEDUCE)` = 103, Riija level 6, 15 mana — `kod/include/blakston.khd:1928; kod/object/passive/spell/seduce.kod:44-47`
- `Message resource ids (this build)` = Lm_party_killed_monster=23469, player_improve_maxhealth=23532, player_spits=23534, player_killed_something=23555, player_advancement_cap_hit_1=23736, deadbody_desc_rsc=26042, corpsepointer_no_loot=28660, Thrust_player_killed_something=28418, punch_=28433, kick_=28441, TouchOfFlame_=28007, HolyTouch_=28019, IcyFingers_=28031, zap_=28044, AcidTouch_=28055 — `kod/kodbase.txt:12990,13596,13598,13619,13800,22253,32878,32043,32106,32145,29922,29964,30011,30054,30099`

### What two agents can exploit or must respect

- Cooperation is close to free. Both agents should attack the SAME monster. Each independently gets gain=2 minimum once it has landed one point of damage and has that monster as poKill_target; the killer gets 3 only if it also took damage. Total group gain is 2N-to-3N for N cooperating agents versus 3 for a solo kill. Cite player.kod:7705-7722 and :7767-7783.
- FOCUS FIRE IS MANDATORY, and for a hard mechanical reason: TryAttack calls @ResetGainFlags the instant poKill_target changes (player.kod:4063-4067), wiping poKill_target, PFLAG_DID_DAMAGE and PFLAG_TOOK_DAMAGE. An agent that alternates swings between two monsters earns nothing on either. Never swing at monster B until monster A is dead.
- Both agents must be in the SAME ROOM AS THE KILLER at the moment of death, not merely in the monster's room. The broadcast target is the killer's poOwner (player.kod:4827), so a DoT/wall kill made by a caster standing in another room delivers the advancement broadcast to the caster's room and the co-damager standing next to the corpse gets nothing.
- There is a clean machine-readable shared-credit signal: monster.kod:1579-1592 posts Lm_party_killed_monster (rsc 23469, 4 parms: killer def, killer name, monster def, monster name) to every player in the room whose GetKillTarget = the dying monster, excluding the killer. Receiving it means 'I had the right target and was in the right room' — everything except the PFLAG_DID_DAMAGE check, which the agent already knows locally. Use it as the credit ack. The killer instead sees one of the *_player_killed_something ids.
- Free damage telemetry for the focused target only: monster.kod:3915-3960 HitPointThreshold and :3964-3990 HealHitPoint post monster health-band and healing messages ONLY to players whose GetKillTarget = that monster. Setting poKill_target is therefore also how an agent subscribes to the target's HP feed. There are 5 bands (piHit_points*5/piMax_hit_points).
- AGGRO CAN BE HELD INDEFINITELY. Once a monster is in STATE_ATTACK, brain.kod:252-253 returns without even trying a target switch, so a designated tank keeps the monster and the DPS agent can hit it with impunity. The tank keeps the monster in STATE_ATTACK by staying inside CanReach — if the tank breaks reach the mob enters STATE_CHASE, where switches become possible, and any transition to WAIT/MOVE/LIMBO zeroes poTarget and piHatred entirely (monster.kod:685-760).
- TWO HARD EXCEPTIONS to aggro holding. (1) The DPS agent's FIRST action in the room fires NotifyMonstersOfPresence -> room.kod FirstMove, which retargets the top-5-hating monsters at it with event=7 (+20 hatred) on a path with NO state gate (user.kod:3114-3131, room.kod:3668-3798). Sequence the pull so the tank engages while the DPS agent has already burned its FirstMove elsewhere, or accept the initial pull. (2) Bait and Mark of Dishonor call @TargetSwitch directly, bypassing AttemptTargetSwitch and the state gate entirely.
- REAL TAUNTS EXIST. Mark of Dishonor (Shalille 4, 12 mana) does Post(oTarget,@TargetSwitch,#what=who,#iHatred=1000) — hatred 1000 is unbeatable by any normal GetHatred value (dishonor.kod:176-179). Bait (Riija 2, 8 mana, no target) sweeps the whole room: for each non-AI_NPC monster, chance = 25 + iSpellPower/2 if it has no target, or 25 + iSpellPower/4 if it does, then TargetSwitch with iHatred=100 plus a forced EnterStateChase (bait.kod:66-111). Bait is the designated group-pull/tank tool. Seduce on failure also taunts, iHatred = bound(iSpellPower*2, 25, 100) (seduce.kod:204-205).
- Piling onto one player makes monsters AVOID that player: hatred is reduced by (GetMonsterChasers * piChaser_factor)/100, where piMonsterChasers is the sum of levels of monsters currently targeting them (brain.kod:900-911, player.kod:12218-12242). This penalty is skipped for TS_FIGHT_ME_VICTIM, i.e. it does NOT apply when the tank personally hits the mob. So the tank should hit things; a passive tank sheds aggro. Also note room.kod:3673-3676 calls ResetMonsterChasers on the player at FirstMove, zeroing the counter and briefly removing the protection.
- LOOT IS LOCKED TO THE KILLER FOR 25 SECONDS, keyed by GetTrueName against the corpse's prPlayer_name (body.kod:99-123, monster.kod:3056-3070). If two agents share one account-independent loot pool, the agent that lands killing blows should be the one that walks the corpse, or the pair should simply wait 25s. Otherwise the non-killer gets corpsepointer_no_loot (rsc 28660).
- The loot lock has exploitable holes an agent should know: the monster's own dropped INVENTORY, tokens, newbie signet rings and item-attribute (magic) weapons all skip the corpse pointer and are grabbable immediately by anyone (trestype.kod:239-242, 256-262, 275-282; monster.kod:5013-5023). Monsters with vrDead_icon = $ produce no corpse and therefore no lock at all. So the single most valuable drop class (itematt weapons) is NEVER loot-locked.
- Rotate the killing blow if the pair wants to split the killer-only rewards. Killing-blow-exclusive rewards: +1 gain when you also took damage, the entire quest-completion credit (questnode.kod:1527-1548 matches killing_player = oQuester), token generation, newbie signet, itematt weapon roll, and the 25s loot lock. Non-killer damagers get 2 gain and nothing else.
- In the NEAR-LEVEL band (monster_level <= your piBase_Max_health but within 5) the non-killer gets exactly ZERO (gain=1 requires killing_blow AND TOOK_DAMAGE, player.kod:7785-7793). When farming monsters at or below your level, credit is killer-only and the pair should alternate killing blows rather than both piling on. Above your level, sharing is nearly free.
- MAGE CREDIT QUIRK worth exploiting: atakspel.kod:128-131 sets kill target with @SetKillTarget (no flag reset) and force-sets PFLAG_DID_DAMAGE. A caster that takes one hit from monster A, then switches to nuking monster B, carries PFLAG_TOOK_DAMAGE across and is credited gain=3 on B's kill without ever being touched by B. Take one hit early, then never switch away using a melee stroke (which WOULD reset).
- A pure healer/tank with zero damage output gets ZERO advancement (player.kod:7764-7765 requires PFLAG_DID_DAMAGE). Every agent in a group must land at least one point of damage on the target, from any source — a melee hit, an attack spell, or standing a wall of fire on it all set the flag.
- FRIENDLY FIRE IS ON for area effects and is NOT gated by any PK check. Earthquake hits every Battler in the room except the caster (earthqua.kod:246-252) and can kill a teammate, which will make the caster a MURDERER (player.kod:4837-4918). Wall of fire / lightning / poison fog damage any Battler that steps into range, caster excluded only if vbCanAffectCaster is FALSE (wallelem.kod:132-160). Cooperating agents must never use earthquake while sharing a room, and must coordinate wall placement.
- The real group penalty is spawn competition, not reward dilution. Spawn rate is fixed at one attempt per ~4000 ms per room and is provably independent of player count (vbScaleSpawnRateWithPlayers is FALSE and is never set TRUE anywhere in the tree — monsroom.kod:22,88-108). piMonster_count_max is a fixed per-room ceiling. So N agents in one room split a fixed monster supply; N agents in N rooms get N times the supply. Cooperate for hard single targets, split up for volume farming.
- Farming cadence for a single room: enter, act once (fires FirstMove and the 1-5 monster initial batch if pbOkay_To_Load and the room is empty of monsters), then one new monster per ~4s up to piMonster_count_max. DO NOT clear a room and then leave with zero monsters — that starts a 180s pbOkay_To_Load lockout that suppresses the initial burst on your next entry (monsroom.kod:335-341, comment 'Endless exp boosting'). Leave one monster alive, or keep one agent standing in the room so LastUserLeft never fires and the ~4s gen timer keeps running.
- An agent can pull without aggro: enter a room and take NO action (PFLAG_MOVED_SINCE_ENTRY stays clear) and monsters will not target you via FirstMove. Useful for a scout that only observes BP_CREATE/BP_MESSAGE traffic, or for a second agent that wants to arrive before the tank engages.
- Monsters below viWimpy health with AI_MOVE_REGROUP run toward their closest ally instead of fleeing outright (brain.kod:588-609), which pulls wounded monsters into the pack rather than out of it. AI_MOVE_OPTIMAL_RANGE casters (shamans) actively back away to spell range (brain.kod:611-622). Neither is party-size dependent.

### Not determined

- I did not verify the exact client->server byte widths for BP_REQ_ATTACK, BP_REQ_CAST, BP_REQ_GET or BP_REQ_LOOK against blakserv/sprocket.c client_def_table — I inferred them from the kod dispatch handler signatures in user.kod:902-1400. Anyone implementing an agent must read client_def_table directly before sending these.
- piPlayer_factor, piChaser_factor and piHyperAggressive_factor are read in brain.kod:900-916 but I did not locate their declared default values (they are properties of Brain or a subclass). Their magnitudes determine whether the MonsterChasers spread-out effect is significant or negligible. Grep the properties block of kod/object/passive/brain.kod and its subclasses in kod/object/passive/brain/.
- I did not enumerate the AI_* behavior flag values or which monster classes set AI_FIGHT_SINGLEMINDED, AI_FIGHT_SWITCHALOT, AI_FIGHT_HYPERAGGRESSIVE or AI_FIGHT_MURDERERS. AI_FIGHT_SINGLEMINDED in particular makes aggro-holding trivially reliable and AI_FIGHT_SWITCHALOT makes it unreliable (brain.kod:658-661, 940-946). This needs a per-class audit of kod/object/active/holder/nomoveon/battler/monster/*.kod for viDefault_behavior.
- I did not determine whether room.kod:1124 SafePlayerAttack (base) returns TRUE or FALSE, nor which rooms override it beyond necarena.kod:155 and tosarena.kod:161. This affects whether a friendly-fire kill actually flags the caster as a murderer.
- Boss-room and special-room SomethingKilled overrides (bossroom.kod:77, feyforst.kod:96, guest6.kod:370, ke4.kod:221, marcry*.kod, icecave1.kod:167, necarena.kod:539) may alter or intercept the broadcast for those specific rooms. I only read the generic room.kod:745 path. An agent farming a named boss room should read that room's override.
- I did not measure whether the SomethingKilled broadcast order over plActive matters. plActive is built with Cons (holder.kod:893) so it is reverse-entry order, but since each player's AdvancementCheck is independent I found no ordering dependency. If a room override mutates shared state mid-broadcast, order would matter.
- I did not trace the 'dLighting only 3 extra bytes if flags != 0' detail for the BP_CREATE object payload — ExtractDLighting is commented out at clientd3d/server.c:391 inside ExtractNewRoomObject, but ExtractObject itself still reads it with includeLight defaulting true. Worth confirming against ExtractObject in clientd3d/server.c and clientd3d/server.h:48 before writing a BP_CREATE parser.
- GetOptimalRange, GetClosestAlly, GetClosestFrightener and CanReach implementations were not read; CanReach in particular is the exact predicate that decides whether a tank stays in STATE_ATTACK (and therefore whether aggro is holdable), so its geometry matters a great deal for positioning an agent. It is called at monster.kod:1044 and brain.kod:940-946.
- I could not find any mechanism that dilutes, splits, or reduces reward based on group size, and I looked at: AdvancementCheck and all its inputs (player.kod:7736-7890), CreateTreasure and GenerateTreasure (monster.kod:4938-5042, trestype.kod:223-311), monster stat derivation (monster.kod:226-230, 1440-1500), the spawn timer (monsroom.kod:88-108), and grepped player.kod for group/party constructs. I am reporting 'nothing' as a definite answer for XP dilution and monster scaling, and 'yes' only for AoE friendly fire and fixed-supply spawn competition.


---

## PvP, karma, safety, and player-visible threat state (Meridian 59, C:/code/meridian59)

Everything a client learns about another player arrives inside the standard 4-byte `flags` field of the embedded "object" structure, built by `User ToCliObject` (kod/object/active/holder/nomoveon/battler/player/user.kod:2331) from `User GetObjectFlags` (user.kod:7302). That field carries: is-a-player, is-attackable (always true, therefore useless as a safety signal), the raw PFLAG_SAFETY bit (transmitted for ALL players, not just self, despite the comment in include/proto.h:367), a 3-bit player-type enum inside OF_PLAYER_MASK encoding murderer/outlaw/DM/creator/superDM/eventchar, a 5-bit drawing-effect enum (invisible / shadow-form-black / translucent), flicker/flash/phase bits, and three viewer-relative guild bits (guildmate/friend/enemy) that are computed per recipient and are suppressed entirely if the target is morphed into a monster. Karma itself is never transmitted for another player; the only karma signal is OF_FLASHING, and only if the viewer holds Detect Evil/Good and the sign tests pass — and OF_FLASHING is overloaded with "revealed by detect invisibility" and with ordinary flashing lights, so it is ambiguous. Whether an attack is legal is decided entirely server-side by `Player AllowPlayerAttack` (player.kod:3615) then `Player CheckStatusAndSafety` (player.kod:3767); a refusal produces no protocol response at all, only an optional BP_MESSAGE (32) text line, and two of the checks are unconditionally silent. Room combat rules (ROOM_SAFE_DEATH, ROOM_NO_COMBAT, ROOM_NO_PK, ROOM_GUILD_PK_ONLY, ROOM_KILL_ZONE) are NEVER sent over the wire — the line that once sent them is commented out at clientd3d/server.c:399 — so an agent must learn room policy by probing or by table. The one global state change that IS observable is a Frenzy (chaos night): every non-inn room's background is switched to redsky.bgf and pushed as BP_BACKGROUND (150).

### Wire formats

**BP_ROOM_CONTENTS (134) — server->client**

```
roomID(4) count(2) then count repetitions of: object, x(2), y(2), angle(2), paletteTranslation, animation, overlays. NOTE the trailing xlat/anim/overlays are a SECOND, independent set (the "move" set from SendMoveAnimation/SendMoveOverlays), in addition to the ones already embedded inside `object` (SendAnimation/SendOverlays via ToCliObject show_type=SHOW_NORMAL). Both sets are full paletteTranslation+animation+overlays triples, so each entry contains TWO of each.
```

*kod .../player/user.kod:2578-2607 (AddPacket(1,BP_ROOM_CONTENTS,4,poOwner,2,objs) then per-object ToCliObject + 2,row 2,col 2,angle + SendMoveAnimation + SendMoveOverlays); clientd3d/server.c:HandleRoomContents and clientd3d/server.c:385-405 ExtractNewRoomObject*

Invisible players ARE included — only DMs with IsDMStealthed are skipped (user.kod:2566-2572 and 2583-2589). x/y are row*FINENESS+fine_row and col*FINENESS+fine_col, i.e. already fine coordinates. clientd3d/server.c:399 contains a commented-out `Extract(&ptr, &current_room.flags, SIZE_VALUE);` — room flags are NOT on the wire today.

**BP_CREATE (217) — server->client**

```
object, x(2), y(2), angle(2), paletteTranslation, animation, overlays — identical per-entry shape to one BP_ROOM_CONTENTS element.
```

*kod .../player/user.kod:6113-6135 (SomethingEntered); clientd3d/server.c:HandleCreate -> ExtractNewRoomObject*

Sent when any object (including an invisible player, or a revenant) enters your room. Stealthed DMs suppressed (user.kod:6118-6123).

**BP_CHANGE (219) — server->client**

```
object, paletteTranslation, animation, overlays. No coordinates. Again two of each: one triple inside `object`, one after it.
```

*kod .../player/user.kod:6540-6575 (SomethingChanged); clientd3d/server.c:HandleChange*

This is the single most information-rich message about another player. It fires on: safety toggle (via SetPlayerFlag->SomethingChanged, player.kod:1104-1121), becoming/losing murderer or outlaw (same path), equipping or removing any item that adds an overlay (player.kod:8662-8683 SetOverlay/RemoveOverlay), and every one-shot action animation: DoAttackSwing (player.kod:9197), DoFistAttack (8489), DoCast (8513), DoBowFire (8525), DoWave (8478), DoPoint (8501). The action is encoded in the object's embedded animation (Player SendAnimation, player.kod:9219-9274): ANIMATE_ONCE 300ms grp2-4 for PANM_WEAPON_ATTACK, ANIMATE_ONCE 600ms grp3-4 for PANM_FIST_ATTACK, ANIMATE_ONCE 1200ms grp5 for PANM_BOW_FIRE. Weapon presence is also visible structurally: an overlay at hotspot HS_RIGHT_WEAPON forces the right-arm overlay group to 17 instead of 1 (player.kod:9513-9516 in SendOverlays, 9354-9357 in SendMoveOverlays).

**BP_REMOVE (218) — server->client**

```
id(4)
```

*kod .../player/user.kod:6139-6155 (SomethingLeft)*

**BP_MOVE (200) — server->client**

```
id(4) x(2) y(2) speed(1)
```

*kod .../player/user.kod:6173-6191 (SomethingMoved / BuildPacketSomethingMoved)*

Sent for invisible players too. Not sent to you for your own CAUSE_USER_INPUT moves.

**BP_TURN (201) — server->client**

```
id(4) angle(2)
```

*kod .../player/user.kod:6209-6219*

**BP_PLAYERS (136) — server->client**

```
count(2) then count repetitions of: id(4), nameRsc(4), nameLen(2)+nameBytes, flags(4). The 4-byte flags are `GetObjectFlags & ~DRAWFX_INVISIBLE`.
```

*kod .../player/user.kod:2535-2545 (ToCliPlayers); clientd3d/server.c:HandlePlayers*

This is the who-list and it is a GLOBAL murderer/outlaw oracle: the OF_PLAYER_MASK bits of EVERY logged-on user are here, for the whole world, regardless of room. Only hidden DMs are filtered (user.kod:2528-2532). Names are true names (GetTrueName), so this defeats the Anonymity spell's blanked room-object name. Requested with BP_SEND_PLAYERS (54, no payload).

**BP_PLAYER_ADD (137) — server->client**

```
id(4), nameRsc(4), nameLen(2)+nameBytes, flags(4) — same entry shape as one BP_PLAYERS element; flags again masked with ~DRAWFX_INVISIBLE.
```

*kod .../player/user.kod:800-806 (SomeoneLogon); clientd3d/server.c:HandleAddPlayer*

**BP_PLAYER_REMOVE (138) — server->client**

```
id(4)
```

*kod .../player/user.kod:844*

**BP_USERCOMMAND / UC_LOOK_PLAYER (155) — server->client**

```
BP_USERCOMMAND(1)=155, subop(1)=2, then: object (built with show_type=SHOW_LOOK, so the embedded animation/overlays are the LOOK set), canEdit(1) (1 if you are looking at yourself or you are an Admin, else 0), descFormatRsc(4), then a VARIABLE number of format parameters determined by the format resource string, then extraInfoLen(2)+bytes, then urlLen(2)+bytes.
```

*kod .../player/user.kod:4327-4370 (SendLookPlayer); module/merintr/merintr.c:1453-1482 (HandleLookPlayer); clientd3d/srvrstr.c:31 (CheckServerMessage)*

DESYNC HAZARD: the parameter block after descFormatRsc has no length. Its size is derived by walking the format string's %d/%i (4 bytes each), %q (2-byte length + bytes) and %s (4-byte resource id, which may itself recursively pull more parameters). For a player with a custom description the format is player_desc_enchanted_none = "%q" (player.kod:321,1521-1526) so it is exactly one 2+n string. For a player with no custom description, Object ShowDesc emits only the 4-byte vrDesc and NO parameters (kod/object.kod:129-133). Content is NOT a safety oracle: ShowExtraInfo (player.kod:1585-1808) emits gender/hometown/age, guild rank if the guild is not secret, faction, justicar flag, visible cargo/token items, honor string and donation years. It does NOT include karma, kill counts, murderer/outlaw status, or safety. If the target is morphed or feign-deathed you get the ILLUSION's look instead (user.kod:4331-4338 -> SendLookPlayerIllusion). Triggered by BP_REQ_LOOK (116) {4,TAG_OBJECT}, and refused silently if the LOOKER is invisible (TryLook, user.kod:4374-4380).

**BP_USERCOMMAND / UC_SAFETY (155) — client->server**

```
BP_USERCOMMAND(1)=155, subop(1)=7, value(1). Nonzero = safety ON, zero = safety OFF.
```

*blakserv/sprocket.c:100 `{ UC_SAFETY, { {1, TAG_INT}, {0, DONE_PARM} } }`; kod .../player/user.kod:1541-1566; module/merintr/merintr.h:55 SendSafety(val); module/merintr/merintr.c:92*

Server always sets/clears PFLAG_SAFETY, but suppresses the confirmation text and wav when the server is SERVER_NO_MURDER (user.kod:1545-1548, 1558-1562). No acknowledgement packet is generated other than the optional BP_MESSAGE; the client learns the real state only by seeing OF_SAFETY come back in its own object flags.

**BP_STAT (group 2, stat 7 = karma) (131) — server->client**

```
BP_STAT(1)=131, group(1)=2, statNum(1)=7, nameRsc(4)=user_stat_karma, type(1)=STAT_VALUE, tag(1)=STAT_INTEGER, value(4), min(4)=-100, max(4)=100, currentMax(4)=value
```

*kod .../player/user.kod:6796-6820 (DrawKarma / SendStatKarma); module/merintr/merintr.c:965-995 (ExtractStatistic); include/proto.h:515-517 (SIZE_STAT_NUM=1, SIZE_STAT_TYPE=1, SIZE_GROUP=1)*

SELF ONLY. Karma is stored internally in hundredths (-10000..10000, player.kod:822-823) and divided by 100 before sending, so the client sees -100..100. There is no message that reports another player's karma.

**BP_BACKGROUND (150) — server->client**

```
backgroundRsc(4)
```

*kod .../player/user.kod:6949-6958 (BackgroundChanged); clientd3d/server.c:HandleBackground*

THE frenzy tell. Room StartChaosNight sets prBackground = background_chaos_night (= redsky.bgf, room.kod:56) and pushes BackgroundChanged for every room that is not ROOM_HOMETOWN (room.kod:3225-3240, kod/util/chaosnight.kod:66-73). So a red sky in a non-inn room means GetChaosNight is TRUE and all PK gating below is bypassed.

**BP_REQ_ATTACK (103) — client->server**

```
attackType(1) target(4)
```

*blakserv/sprocket.c:29 `{ BP_REQ_ATTACK, { {1, TAG_INT}, {4, TAG_OBJECT}, {0, DONE_PARM} } }`; kod .../player/user.kod:1104-1116*

There is no success/failure reply. A refused attack yields at most a BP_MESSAGE (32) with the refusal resource, and for two conditions nothing at all.

**BP_MESSAGE (32) — server->client**

```
formatRsc(4) then variable format parameters (same CheckServerMessage walk as UC_LOOK_PLAYER)
```

*kod .../player/user.kod:3217 (MsgSendUser); include/proto.h:67*

Every refusal listed in the rules section arrives as one of these, or as BP_SYS_MESSAGE (31).

**BP_SAID (206) — server->client**

```
speakerID(4) nameRsc(4) sayType(1) formatRsc(4) [+ format parameters] textLen(2)+bytes
```

*kod .../player/user.kod:6515-6533*

Relevant because the speaker's real object id is always present even when the displayed name is blanked (Anonymity) or replaced (Morph). Cross-referencing this id against BP_PLAYERS gives you the true identity and the murderer/outlaw bits.

### Rules, in the order the server checks them

| | rule | where |
|---|---|---|
| message | Room veto first. AllowPlayerAttack picks oRoom = the VICTIM's room if the victim is elsewhere, otherwise your own room, then calls oRoom ReqSomethingAttack. If that returns FALSE the attack dies. | `kod/object/active/holder/nomoveon/battler/player.kod:3619-3637` |
| message | Room ReqSomethingAttack, in its own order: (1) if IsArena, delegate to the arena Watcher (or allow if there is none); (2) ROOM_NO_MOB_COMBAT and either side is a Monster -> refuse; (3) ROOM_NO_COMBAT -> refuse; (4) ROOM_NO_PK and attacker is a Player and victim is a Player or $ -> refuse; (5) ROOM_GUILD_PK_ONLY and both Players -> refuse unless AllowGuildAttack passes or the server is SERVER_NO_MURDER. | `kod/object/active/holder/room.kod:1226-1273` |
| message | AllowGuildAttack (ROOM_GUILD_PK_ONLY gate): monsters on either side always pass. Otherwise the attack fails if the ATTACKER is unguilded AND not a murderer AND has no SoldierShield, OR if the VICTIM holds no Token AND is unguilded AND is not a murderer AND has no SoldierShield. | `kod/object/active/holder/room.kod:1276-1315` |
| **silent** | If oRoom IsArena -> return TRUE immediately. Nothing below (no PK-enable check, no safety, no outlaw branding, no karma change, no faction loss) applies inside an arena. | `kod/object/active/holder/nomoveon/battler/player.kod:3639-3643; base Room IsArena returns FALSE (room.kod:3265); only TosArena (kod/object/active/holder/room/tosrm/tosarena.kod:316) overrides it to TRUE` |
| **silent** | If SYS GetChaosNight (a Frenzy is running) -> return TRUE immediately. Same total bypass as the arena. | `kod/object/active/holder/nomoveon/battler/player.kod:3645-3649; kod/util/system.kod:4559-4562` |
| **silent** | A mortal event character (IsClass &DM AND IsEventCharacter AND NOT PlayerIsImmortal) is always attackable -> return TRUE. | `kod/object/active/holder/nomoveon/battler/player.kod:3651-3657` |
| message | Monster victims: if the victim is a &Reflection and YOU lack PFLAG_PKILL_ENABLE -> refuse. This branch ignores the `report` argument and ALWAYS messages you. | `kod/object/active/holder/nomoveon/battler/player.kod:3661-3668` |
| message | Monster victims: on a SERVER_NO_MURDER server you may not attack a pet (a monster with a master). | `kod/object/active/holder/nomoveon/battler/player.kod:3670-3682` |
| message | Player victims: on a SERVER_NO_MURDER server (SYS IsPKAllowed FALSE), all player-vs-player attacks are refused unless the victim is a &DM. | `kod/object/active/holder/nomoveon/battler/player.kod:3688-3698; kod/util/system.kod:5300-5308` |
| **silent** | Player victims: if NOT victim IsLikelyVictim -> refuse. SILENT, unconditionally — `report` is not consulted. Battler IsLikelyVictim returns TRUE; DM overrides it to FALSE when pbImmortal or DMFLAG_INVISIBLE. | `kod/object/active/holder/nomoveon/battler/player.kod:3700-3704; kod/object/active/holder/nomoveon/battler.kod:171-175; kod/object/active/holder/nomoveon/battler/player/user/dm.kod:406-418` |
| message | Player victims, and only if oRoom does NOT have ROOM_KILL_ZONE: you must have PFLAG_PKILL_ENABLE, and the victim must have PFLAG_PKILL_ENABLE. Either failure refuses. ROOM_KILL_ZONE therefore removes the newbie protection on BOTH sides. | `kod/object/active/holder/nomoveon/battler/player.kod:3706-3747` |
| **silent** | CheckStatusAndSafety, step 1: if the victim is a Monster, or the victim is USING a &Token, skip all safety/outlaw logic — only CheckFactionAttack still applies. Token holders are free targets. | `kod/object/active/holder/nomoveon/battler/player.kod:3767-3784` |
| **silent** | CheckStatusAndSafety, step 2: victim = self, or victim has PFLAG_ANONYMOUS, or victim has PFLAG_MORPHED -> return TRUE with no penalty at all. Attacking a morphed or anonymous player never triggers safety, never brands you outlaw, and never costs faction. | `kod/object/active/holder/nomoveon/battler/player.kod:3786-3793` |
| **silent** | CheckStatusAndSafety, step 3: if your guild and the victim's guild are MUTUAL enemies (Guild IsMutualEnemy both ways is not required here — one call), or your SoldierShield says IsEnemyAttack, the attack is free: piTimeAttackedPlayer is stamped and TRUE is returned. No safety check, no outlaw brand, no faction loss. | `kod/object/active/holder/nomoveon/battler/player.kod:3795-3812` |
| message | CheckStatusAndSafety, step 4 (the safety flag): if the victim is NEITHER a murderer NOR an outlaw and YOU have PFLAG_SAFETY set, the attack is refused. If the victim IS a murderer or outlaw, safety is bypassed entirely — you can always hit them. | `kod/object/active/holder/nomoveon/battler/player.kod:3814-3836` |
| message | CheckStatusAndSafety, step 5 (outlaw branding): safety OFF, victim innocent, and you are neither murderer nor outlaw -> you are branded PFLAG_OUTLAW immediately and EvaluatePKStatus runs. The attack still proceeds. | `kod/object/active/holder/nomoveon/battler/player.kod:3838-3849` |
| message | CheckStatusAndSafety, step 6: CheckFactionAttack. Skipped when what=$, your faction is FACTION_NEUTRAL, target is self, you are in an arena, or GetChaosNight. Also skipped for &User targets if SERVER_FLAG_DISABLE_FACTION_LOSS. Otherwise attacking your OWN faction boots you out of it — unless the target is murderer/outlaw/anonymous/morphed. | `kod/object/active/holder/nomoveon/battler/player.kod:3862-3939` |
| message | On success AllowPlayerAttack stamps piTimeAttackedPlayer = GetTime() (seconds) and cancels any pending ptRescue timer. | `kod/object/active/holder/nomoveon/battler/player.kod:3756-3764, 3810, 3860` |
| message | CanHelpPlayer: for ATTACKED_PLAYER_WAIT (900) seconds after piTimeAttackedPlayer, and only outside a Frenzy, you are un-helpable. Consequence: nobody may cast a non-harmful spell on you unless the room's AllowGuildAttack passes; the anti-mule check in Spell ReqCast refuses with spell_cant_help. It also doubles your logoff penalty increment, and blocks the SoldierShield faction-rank bonus for killing you. | `kod/object/active/holder/nomoveon/battler/player.kod:104-105 (ATTACKED_PLAYER_WAIT = 15 * 60), 3948-3956; kod/object/passive/spell.kod:576-591 and 863-883; kod/object/active/holder/nomoveon/battler/player/user.kod:760-776; kod/object/item/passitem/defmod/shield/soldshld.kod:228-236` |
| message | How a player becomes PK-enabled (EvaluatePKStatus). PFLAG_PKILL_LOCK short-circuits everything. Otherwise: you GAIN PFLAG_PKILL_ENABLE if you are in a guild (poGuild <> $) OR piBase_Max_health >= PKILL_ENABLE_HP (30) OR you are a murderer OR you are an outlaw. You LOSE it if you are unguilded AND below 30 base max health AND not murderer AND not outlaw. Gaining it also force-sets PFLAG_TUTORIAL and clears the newbie honor string. | `kod/object/active/holder/nomoveon/battler/player.kod:11047-11106; PKILL_ENABLE_HP at kod/include/blakston.khd:2094` |
| **silent** | CheckPlayerFlag has a special case that will bite you: asking for PFLAG_SAFETY on a SERVER_NO_MURDER server returns TRUE unconditionally, regardless of the stored bit. GetObjectFlags does NOT use CheckPlayerFlag — it tests piFlags & PFLAG_SAFETY directly — so the OF_SAFETY bit on the wire can disagree with what the server's own gameplay checks see. | `kod/object/active/holder/nomoveon/battler/player.kod:1124-1136 vs kod/object/active/holder/nomoveon/battler/player/user.kod:7353-7356` |
| message | Consequences of actually killing a player (Player SomethingKilled path). Only runs if the victim IsClass &User, the room's SafePlayerAttack is FALSE (i.e. not ROOM_SAFE_DEATH), and victim <> self. Victim murderer/outlaw -> piJustified_kill_count++. Victim innocent -> piKill_count++ and piKill_count_decay++. Karma is always adjusted via CalculateKarmaChangeFromKill. Then, if the victim was NOT murderer/outlaw/anonymous/morphed, and you are not in a mutual guild war and not a valid faction-soldier kill, and the victim held no Token: you are branded PFLAG_MURDERER (and PFLAG_OUTLAW is cleared), and you roll RevenantChance for PFLAG_HAUNTED. | `kod/object/active/holder/nomoveon/battler/player.kod:4837-4925` |
| **silent** | Revenant creation. Chance = RevenantChance, which returns 0 if you are in a Guildhall, or you have PFLAG2_NOHAUNT (guide/guardian only), or the VICTIM was outlaw or murderer, or your guild and theirs are mutual enemies. Base 10, +20 same guild, +/-10 per one-way ally/enemy, +15 same faction / -5 different faction, + (10*yourMaxHP)/theirMaxHP, + abs(theirKarma - yourKarma)/20, + up to 20 for the fraction of your health remaining, bounded 2..30, then + 5*piKill_count_decay, then scaled up by a Martyr's Battleground room enchantment. The roll is skipped entirely during a Frenzy. | `kod/object/active/holder/nomoveon/battler/player.kod:5029-5115, 4903-4913` |
| message | Revenant behaviour and cost. It is created 3-12s later near you, is INVISIBLE (GetObjectFlags returns BATTLER_YES | DRAWFX_INVISIBLE only — no OF_PLAYER, no player-type bits), walks and attacks through walls, and is single-mindedly aggressive. Fleeing the room deletes it and Player NewOwner spawns a fresh, STRONGER one (level 150% of maxHP + 5*kill_count_decay vs the initial 110% + 7*kill_count_decay) as long as the new room is not ROOM_NO_COMBAT, ROOM_SANCTUARY or ROOM_SAFE_DEATH and there is no Frenzy. Anyone else who attacks or kills the revenant becomes PFLAG_HAUNTED themselves. PFLAG_HAUNTED clears only when the revenant dies, or on a full-cost death. | `kod/object/active/holder/nomoveon/battler/monster/revenant.kod:16-27, 71-101, 233-236, 244-311; kod/object/active/holder/nomoveon/battler/player.kod:1439-1461; 8216-8234` |
| message | PFLAG_OUTLAW is cleared by any death whose piDeathCost >= Settings GetDefaultDeathCost (100). PFLAG_MURDERER is NOT cleared by death — only by a Justicar pardon at the Barloque clerk (murderer -> outlaw, then outlaw -> lawful) or by a full character restart/suicide. Murderers also take double spell/skill proficiency loss on death (-2 instead of -1), always roll for the -1 base max health penalty (the /3 death-cost reduction is denied to them), and get no consolation gmail or half-mana broadcast. | `kod/object/active/holder/nomoveon/battler/player.kod:8202-8299, 8180-8192; kod/object/active/holder/nomoveon/battler/monster/towns/barlqtwn/bqclerk.kod:521-547; kod/object/active/holder/nomoveon/battler/player.kod:2324-2329 (ResetCharacter)` |
| **silent** | ROOM_SAFE_DEATH (Room SafePlayerAttack) means death is fake: health is set to 1 and you are not really killed, kills there produce no karma/murderer/outlaw/faction consequences, and no advancement is granted. Only two rooms in the tree carry it as a permanent flag: NecArena and TosArena. Both also override ArenaRealDeath to a runtime pbRealdeath switch that admins can flip. | `kod/object/active/holder/room.kod:1124-1131; kod/object/active/holder/nomoveon/battler/player.kod:7963-7982, 7748-7752, 4837; kod/object/active/holder/room/necarena.kod:68,532-537; kod/object/active/holder/room/tosrm/tosarena.kod:99,748-752` |
| **silent** | NONE of the room combat flags are visible to the client. There is no BP message carrying piRoom_flags; clientd3d/server.c:399 has the historical line commented out. The only room-policy hint the server volunteers is the ROOM_KILL_ZONE entry/exit warning in User NewOwner — and it is sent ONLY to players who lack PFLAG_PKILL_ENABLE and only outside a Frenzy, so a PK-capable player is told nothing at all. | `clientd3d/server.c:396-399; kod/object/active/holder/nomoveon/battler/player/user.kod:6049-6068` |
| **silent** | Frenzy (chaos night) effects: every non-ROOM_HOMETOWN room gets ROOM_KILL_ZONE forced ON and ROOM_NO_COMBAT / ROOM_GUILD_PK_ONLY / ROOM_NO_PK / ROOM_NO_MAGIC forced OFF (via TrySetRoomFlag, which declines if the current value already differs from the permanent one), plus the redsky background. AllowPlayerAttack returns TRUE unconditionally. No karma change from player kills, no revenants, PFLAG_HAUNTED is cleared on death, no death penalties, no faction loss, deaths drop nothing, and you respawn with half health/mana and 100 vigor. The Underworld opts out of the flag changes. | `kod/util/chaosnight.kod:60-89; kod/object/active/holder/room.kod:3225-3240; kod/object/active/holder/nomoveon/battler/player.kod:3645-3649, 6528-6534, 4906, 8145-8151, 8203-8212, 7993-7999; kod/object/active/holder/room/monsroom/uworld.kod:712-723` |
| **silent** | Karma reveal condition (Detect Evil): the VIEWER must have PFLAG2_DETECT_EVIL, viewer karma > 0, target karma < -10, and the target must be a Player (or a Monster whose abs(karma) exceeds the viewer's karma). Then OF_FLICKERING is cleared and OF_FLASHING set on that object. Detect Good is the mirror: viewer PFLAG2_DETECT_GOOD, viewer karma < 0, target karma > 10. | `kod/object/active/holder/nomoveon/battler/player/user.kod:2371-2392` |
| **silent** | Invisibility reveal condition (Detect Invisibility): the VIEWER must have PFLAG2_DETECT_INVIS and the target's drawfx must equal DRAWFX_INVISIBLE exactly. Then the whole DRAWFX_MASK and OF_FLICKERING are cleared and OF_FLASHING set — the target renders normally and glows. Shadow Form (DRAWFX_BLACK) is NOT revealed by this, because the test is equality against DRAWFX_INVISIBLE (0x500000), not a subset test. | `kod/object/active/holder/nomoveon/battler/player/user.kod:2361-2368; kod/object/passive/spell/persench/detinvis.kod:65-95; kod/object/passive/spell/persench/shadform.kod:95-100` |
| **silent** | Guild bits are viewer-relative and require BOTH sides to be guilded. PLAYER_IS_GUILDMATE if same guild object. PLAYER_IS_FRIEND requires MUTUAL alliance (both Guild IsAlly calls must pass). PLAYER_IS_ENEMY requires Guild IsMutualEnemy. All three are skipped entirely if the target has PFLAG_MORPHED with a Monster illusion form — so a morphed enemy shows up with no guild bits AND no OF_PLAYER bit. | `kod/object/active/holder/nomoveon/battler/player/user.kod:2394-2423; kod/object/active/holder/nomoveon/battler/player/user.kod:7358-7371 (morph strips USER_YES and OFFER_YES)` |
| **silent** | Player flag persistence across logout. ResetPlayerFlagList masks piFlags with PFLAG_MASK (0x463D7E) and piFlags2 with PFLAG2_MASK (0x000080), then re-applies flags from enchantments, used items and room enchantments. Surviving: MURDERER, SAFETY, OUTLAW, DID_DAMAGE, TOOK_DAMAGE, DODGED, HAUNTED, PKILL_ENABLE, TUTORIAL, PKILL_LOCK, INTRIGUING, LOG, SQUELCHED, MOVED_SINCE_ENTRY. Cleared: INVISIBLE, TRANCE, MANA_FOCUS, NO_FIGHT, NO_MAGIC, NO_MOVE, ANONYMOUS, FORGOTTEN, MORPHED, and in flagset 2 everything except NOHAUNT (so HASTED, DANCING, all three DETECT_* and HUNTED are lost). | `kod/object/active/holder/nomoveon/battler/player.kod:1154-1193; kod/include/blakston.khd:2098-2139` |
| message | Guests are force-PK-enabled at logon and get the player_guardian_angel text instead of player_safety_caught when their safety catches an attack. | `kod/object/active/holder/nomoveon/battler/player/user/guest.kod:107-118; kod/object/active/holder/nomoveon/battler/player.kod:3821-3827` |
| **silent** | DM/Admin overrides sit above the normal path: DM AllowPlayerAttack refuses (silently, with a DontInterfere call) if the DM lacks pbAdvancement, and returns TRUE if pbImmortal or IsEventCharacter. Admin AllowPlayerAttack returns TRUE if PlayerIsImmortal. Stealthed DMs are omitted from BP_ROOM_CONTENTS, BP_CREATE, BP_REMOVE, BP_MOVE, BP_TURN and BP_CHANGE entirely — they are the only truly unobservable actors. | `kod/object/active/holder/nomoveon/battler/player/user/dm.kod:542-558; kod/object/active/holder/nomoveon/battler/player/user/dm/admin.kod:121-129; kod/object/active/holder/nomoveon/battler/player/user.kod:2566-2572, 6118-6123, 6141-6146, 6161-6166, 6196-6201, 6542-6547` |

### Constants

- `OF_PLAYER / USER_YES` = 0x00000004 — `include/proto.h:358; kod/include/blakston.khd:59`
- `OF_ATTACKABLE / BATTLER_YES` = 0x00000008 — set on EVERY player unconditionally (MOVEON_NO|BATTLER_YES|USER_YES|OFFER_YES), so it carries no PK information — `include/proto.h:359; kod/include/blakston.khd:61; kod/object/active/holder/nomoveon/battler/player/user.kod:7306`
- `OF_OFFERABLE / OFFER_YES` = 0x00000200 — also unconditional on players, stripped only when morphed — `include/proto.h:362; kod/object/active/holder/nomoveon/battler/player/user.kod:7306,7369`
- `OF_SAFETY / SAFETY_YES` = 0x00002000 — proto.h comments "self only" but the kod sets it for every player object it serialises, so it is readable for OTHER players too — `include/proto.h:367; kod/include/blakston.khd:87; kod/object/active/holder/nomoveon/battler/player/user.kod:7353-7356`
- `OF_PLAYER_MASK` = 0x0001C000 — a 3-bit enum in bits 14-16: 0=normal, 0x4000 PF_KILLER (=PFLAG_MURDERER), 0x8000 PF_OUTLAW, 0xC000 PF_DM, 0x10000 PF_CREATOR, 0x14000 PF_SUPER (green-named DM), 0x18000 unused, 0x1C000 PF_EVENTCHAR. Precedence in GetObjectFlags: Creator > EventCharacter > SuperDM > DM > Murderer > Outlaw (murderer wins over outlaw). — `include/proto.h:368,398-403,409; kod/include/blakston.khd:119-126; kod/object/active/holder/nomoveon/battler/player/user.kod:7308-7345`
- `PF_CREATOR aliases OF_HANGING` = both 0x00010000 — for a non-player this bit means ceiling-pinned; for a player it is part of the player-type enum — `include/proto.h:370-373,401`
- `OF_FALSEPLAYER` = 0x00000800 (aliases OF_ACTIVATABLE). Explicitly cleared for real players; set only by &Reflection when mirroring a Player, so it is the reliable way to tell a reflection from the real thing. — `include/proto.h:379-381; kod/include/blakston.khd:81-83; kod/object/active/holder/nomoveon/battler/player/user.kod:7360; kod/object/active/holder/nomoveon/battler/monster/reflectn.kod:318-335`
- `OF_ENEMY / PLAYER_IS_ENEMY` = 0x02000000 — `include/proto.h:405; kod/include/blakston.khd:128`
- `OF_FRIEND / PLAYER_IS_FRIEND` = 0x04000000 — `include/proto.h:406; kod/include/blakston.khd:129`
- `OF_GUILDMATE / PLAYER_IS_GUILDMATE` = 0x08000000 — `include/proto.h:407; kod/include/blakston.khd:130`
- `OF_FLICKERING` = 0x00020000 — `include/proto.h:375; kod/include/blakston.khd:92`
- `OF_FLASHING` = 0x00040000 — the ONLY karma/invisibility-detection signal, and it is overloaded three ways (detect evil, detect good, revealed invisible) plus ordinary flashing lights — `include/proto.h:376; kod/include/blakston.khd:94; kod/object/active/holder/nomoveon/battler/player/user.kod:2366,2384,2390`
- `OF_BOUNCING` = 0x00060000 = FLICKERING|FLASHING both set. The client suppresses the bounce motion for OF_PLAYER objects but still runs both light animations. — `include/proto.h:377; clientd3d/moveobj.c:233-235; clientd3d/animate.c:188,237`
- `OF_PHASING` = 0x00080000 — client overwrites OF_EFFECT_MASK each frame from a phaseStates table — `include/proto.h:378; clientd3d/animate.c:256-263`
- `OF_EFFECT_MASK / DRAWFX_MASK` = 0x01F00000. Values: 0 plain, 0x100000 TRANSLUCENT25, 0x200000 TRANSLUCENT50, 0x300000 TRANSLUCENT75, 0x400000 BLACK (= Shadow Form), 0x500000 INVISIBLE, 0x600000 TRANSLATE (client-internal), 0x700000 DITHERINVIS, 0x800000 DITHERTRANS, 0x900000 DOUBLETRANS, 0xA00000 SECONDTRANS — `include/proto.h:384-396; kod/include/blakston.khd:101-112`
- `PFLAG_INVISIBLE / MURDERER / SAFETY / OUTLAW / HAUNTED / PKILL_ENABLE / PKILL_LOCK / ANONYMOUS / MORPHED` = 0x000001 / 0x000002 / 0x000004 / 0x000008 / 0x000100 / 0x000400 / 0x001000 / 0x080000 / 0x200000 — `kod/include/blakston.khd:2100-2125`
- `PFLAG2_DETECT_GOOD / DETECT_EVIL / DETECT_INVIS / HUNTED / NOHAUNT` = 0x000004 / 0x000008 / 0x000010 / 0x000040 / 0x000080 — `kod/include/blakston.khd:2132-2138`
- `PFLAG_MASK / PFLAG2_MASK` = 0x463D7E / 0x000080 — what survives ResetPlayerFlagList — `kod/include/blakston.khd:2098,2129`
- `PKILL_ENABLE_HP` = 30 (base max health threshold at or above which a player loses their guardian angel and becomes attackable/able to attack) — `kod/include/blakston.khd:2094`
- `ATTACKED_PLAYER_WAIT` = 15 * 60 = 900 seconds. GetTime() is unix seconds minus a 1534000000 offset, so this is a plain 900-second window. — `kod/object/active/holder/nomoveon/battler/player.kod:105; blakserv/ccode.c:1892-1907`
- `ROOM_SAFE_DEATH / NO_COMBAT / NO_PK / GUILD_PK_ONLY / SANCTUARY / KILL_ZONE / NO_MOB_COMBAT` = 0x0001 / 0x0002 / 0x0004 / 0x0008 / 0x0080 / 0x0200 / 0x8000 — `kod/include/blakston.khd:1034-1066`
- `Permanent room-flag census in this tree` = ROOM_NO_COMBAT 66 rooms, ROOM_SAFELOGOFF 24, ROOM_SANCTUARY 16, ROOM_GUILD_PK_ONLY 15, ROOM_HOMETOWN 9, ROOM_GUEST_AREA 8, ROOM_SAFE_DEATH 2 (NecArena, TosArena). ZERO rooms declare ROOM_KILL_ZONE or ROOM_NO_PK permanently. — `grep of viPermanent_flags across kod/object/active/holder/room/`
- `Karma storage / transport scale` = piKarma is hundredths, clamped to [-10000, 10000] by NewKarma; GetKarma and the BP_STAT wire value are piKarma/100, i.e. [-100, 100] — `kod/object/active/holder/nomoveon/battler/player.kod:822-823, 6429-6433, 6465-6478`
- `Karma kill swing factors` = Settings piKillKarmaSwingNeutral = 2, piKillKarmaSwingMonster = 6, piKillKarmaSwingPlayer = 10 (10 = maximum swing; change = -((d^3)/2500 + 5d) / (11 - swing) where d = killerKarma - actKarma) — `kod/util/settings.kod:50-52, 241-253; kod/object/active/holder/nomoveon/battler/player.kod:6491-6591`
- `Settings piDefaultDeathCost` = 100 — the threshold piDeathCost must reach for a death to clear PFLAG_OUTLAW and PFLAG_HAUNTED — `kod/util/settings.kod:59, 226-229; kod/object/active/holder/nomoveon/battler/player.kod:8216-8234`
- `SERVER_NORMAL / SERVER_NO_MURDER` = 0 / 1 — IsPKAllowed returns FALSE iff piServer_type = SERVER_NO_MURDER — `kod/include/blakston.khd:2656-2657; kod/util/system.kod:5300-5308`
- `SUICIDE_REPEAT_TIME` = 600 seconds — minimum interval between UC_SUICIDE character restarts (a restart clears MURDERER, OUTLAW, HAUNTED, PKILL_ENABLE, PKILL_LOCK, kill counts and karma) — `kod/object/active/holder/nomoveon/battler/player/user.kod:32, 1520-1540; kod/object/active/holder/nomoveon/battler/player.kod:2264-2330`
- `UC_SAFETY sub-opcode` = 7 (inside BP_USERCOMMAND = 155) — `include/proto.h:229; kod/include/protocol.khd:173`
- `UC_LOOK_PLAYER sub-opcode` = 2 — `include/proto.h:223; kod/include/protocol.khd:167`
- `background_chaos_night` = redsky.bgf — the frenzy sky — `kod/object/active/holder/room.kod:56, 3236`
- `Revenant object flags` = BATTLER_YES | DRAWFX_INVISIBLE = 0x00500008 exactly — no OF_PLAYER, no OF_GETTABLE, no player-type bits — `kod/object/active/holder/nomoveon/battler/monster/revenant.kod:233-236`
- `TIME_FLASH / FLASH_LEVEL (client render of OF_FLASHING)` = 1000 ms period, amplitude LIGHT_LEVELS/2 sine on lightAdjust; unlike OF_FLICKERING it is NOT gated on daylight — `clientd3d/animate.c:31,34,237-246; clientd3d/d3drender_objects.c:2507-2515`

### What two agents can exploit or must respect

- The single cheapest safety primitive is the who-list. BP_SEND_PLAYERS (54) with no payload returns BP_PLAYERS (136) listing EVERY logged-on user's id, true name and 4-byte object flags. The OF_PLAYER_MASK enum in those flags gives you the murderer/outlaw/DM status of the whole server population at once, from anywhere. Two cooperating agents can share one such snapshot and both know who is dangerous, with no line of sight required. Refresh triggers itself: the server posts UpdateWhoListForAll to every user whenever anyone's PFLAG_MURDERER or PFLAG_OUTLAW changes — but ONLY if SYS IsServerCrowded is false, so under load your list silently goes stale (kod/object/active/holder/nomoveon/battler/player.kod:1104-1112; kod/util/system.kod:6594-6602).
- OF_SAFETY (0x2000) is on the wire for every player object you receive, not just your own. Nothing in the shipped client reads it for anyone but self (module/merintr/mermain.c:412), so this is free information a cooperating pair can exploit: a stranger whose OF_SAFETY is CLEAR has deliberately turned safety off and can legally strike an innocent; a stranger with OF_SAFETY SET cannot hit you unless you are flagged murderer or outlaw. Caveat: on a SERVER_NO_MURDER server the bit reflects the stored flag while the server's own CheckPlayerFlag(PFLAG_SAFETY) always answers TRUE, so the bit can under-report actual protection there.
- OF_ATTACKABLE is worthless as a threat signal — every player has it set unconditionally. Do not use it to infer PK legality.
- Watch BP_CHANGE (219) on other players as your combat-intent tripwire. It fires on weapon equip/unequip (an overlay at hotspot HS_RIGHT_WEAPON, which also flips the right-arm overlay group from 1 to 17), on the one-shot swing/fist/cast/bow-fire animations, and on murderer/outlaw/safety flag transitions. An agent that diffs consecutive BP_CHANGE payloads for a given id gets "they just drew a weapon" and "they just swung" and "they just went outlaw" for free.
- Invisible players are NOT filtered from the protocol. BP_ROOM_CONTENTS, BP_CREATE, BP_MOVE and BP_TURN all carry them; only the DRAWFX_INVISIBLE bit in flags tells the stock client to hide them. Any agent reading the wire directly already sees every invisible player's exact position and heading in its room. The only genuinely hidden actor is a DM with IsDMStealthed, who is excluded from all six of those messages.
- Revenants are also on the wire, with the unmistakable signature flags = BATTLER_YES|DRAWFX_INVISIBLE (0x00500008) and name resource "revenant". Spotting one identifies its hauntee as a fresh murderer with a strength/karma profile you can estimate: level = 110% of their base max health at first spawn, 150% + 5*kill_count_decay on every re-spawn after they flee a room.
- Killing an innocent is not the only route to being flagged. Merely LANDING an unprovoked attack brands you PFLAG_OUTLAW instantly (player.kod:3838-3849), which immediately flips your OF_PLAYER_MASK to PF_OUTLAW and pushes a BP_CHANGE to everyone in the room and a who-list refresh to the whole server. Outlaw and murderer are also open season: safety no longer protects anyone from hitting you, and you generate no revenant for whoever kills you.
- There are four total bypasses of the entire PK rule set, in this order: the victim's room being an arena, a Frenzy running, the victim being a mortal event character, and (later) the victim holding a Token or being anonymous/morphed. The first two return TRUE before any safety, PK-enable, karma or faction logic runs. Only the Frenzy is detectable from the client (red sky via BP_BACKGROUND); arena membership is not, so agents must hard-code TosArena and NecArena.
- Room policy is invisible. Plan for probing: BP_REQ_ATTACK (103) that is refused produces NO protocol acknowledgement — at most a BP_MESSAGE line. Use `report=FALSE`-style probing is not available to a client, so a failed attack is indistinguishable from a lost packet unless you parse the message text. The four room refusal strings are literal and stable: "You can't fight here.", "You cannot attack another player here.", "Only those in guilds may attack each other here.", "You cannot attack monsters here."
- Two refusals are unconditionally silent even to the attacker: `NOT victim IsLikelyVictim` (player.kod:3700-3704, i.e. immortal or invisible DM) and the arena Watcher veto inside ReqSomethingAttack. If your attack produces neither damage nor a message, one of those two fired.
- Guild bits are asymmetric and per-viewer. PLAYER_IS_FRIEND requires a MUTUAL alliance (both directions), PLAYER_IS_ENEMY requires IsMutualEnemy. Two agents in different guilds will see DIFFERENT flag values for the same third party, so never share raw OF_ENEMY/OF_FRIEND bits between agents as if they were objective — share the target's object id and each agent's own reading.
- A mutual guild war is a total consequence-free-fire licence between the two guilds: CheckStatusAndSafety returns TRUE before the safety check, so no safety catch, no outlaw brand, no faction loss, no murderer flag on the kill, and RevenantChance returns 0. Same for two SoldierShield-bearing enemy-faction soldiers.
- Morph is the strongest concealment in the game and it is structural, not cosmetic. A morphed player loses USER_YES (OF_PLAYER) and OFFER_YES from their flags, loses all three guild bits, reports the illusion's icon and name, and — critically — attacking them incurs NO safety catch, NO outlaw brand, NO murderer flag and NO faction loss. Anonymity (PFLAG_ANONYMOUS) grants the same penalty immunity while keeping OF_PLAYER, and blanks the room-object name via GetApparentName. Both are defeated by cross-referencing the object id against BP_PLAYERS (which uses GetTrueName), and by BP_SAID, which always carries the real speaker id.
- Karma is not observable for another player under any circumstance except the OF_FLASHING pulse, which requires the viewer to hold Detect Evil (viewer karma > 0, target karma < -10) or Detect Good (viewer karma < 0, target karma > +10). OF_FLASHING is also produced by Detect Invisibility reveals and by ordinary flashing light sources, so it is a hint, not a reading. Casting either detect spell also forces a full BP_ROOM_CONTENTS resend, which is a visible protocol tell to anyone watching your own traffic and a convenient way for you to re-baseline the room.
- Shadow Form (DRAWFX_BLACK, 0x400000) is NOT stripped by Detect Invisibility — the reveal test is drawfx == DRAWFX_INVISIBLE (0x500000) exactly. A shadow-formed player stays black-rendered against a detect-invis holder, and the client colours their name black in preference to any player-type colour (clientd3d/color.c:608-610), which means a shadow-formed MURDERER's red name is masked by the black. Do not rely on name colour; read the flag bits.
- After you land any successful attack on a player, you are un-buffable for 900 seconds: allies cannot land non-harmful spells on you (spell_cant_help) unless the room's AllowGuildAttack passes for the pair. For a two-agent fighter/healer pair this is the binding constraint — the healer must either be in the same guild war/room condition or the fighter must not have swung in the last 15 minutes. It also doubles the fighter's logoff penalty increment.
- Do not attack players below 30 base max health who are unguilded, and do not attack while you are below it yourself: both sides need PFLAG_PKILL_ENABLE outside a ROOM_KILL_ZONE. You cannot read another player's PFLAG_PKILL_ENABLE from the wire at all — it is not in the object flags. The only proxy is that unguilded low-health players tend to still carry the newbie honour string, visible only via UC_LOOK_PLAYER's extra-info block.
- Faction friendly fire: attacking your own faction boots you out of it (unless the target is murderer/outlaw/anonymous/morphed, or you are in an arena, or a Frenzy is on, or SERVER_FLAG_DISABLE_FACTION_LOSS is set for &User targets). Faction is readable via UC_LOOK_PLAYER's extra-info string ("A staunch servant of Duke Akardius" etc., player.kod:1679-1704), so a look is the cheap pre-attack faction check.
- piKill_count_decay only ever increases in the shipped tree. DecayPKillCount (player.kod:11707-11718) is defined and never called from anywhere in kod, so the +5-per-prior-unjustified-kill term in RevenantChance is permanent until a character restart. A serial murderer's revenant chance grows without bound (bounded portion caps at 30, the decay term does not).

### Not determined

- Whether an admin/DM can set ROOM_KILL_ZONE or ROOM_NO_PK at runtime outside a Frenzy. Room SetRoomFlag is a plain public message and no room declares either flag permanently, but I did not trace the admin-mode command table in kod/object/active/holder/nomoveon/battler/player/user/dm/admin.kod to confirm an exposed setter. If one exists, the "ROOM_KILL_ZONE only during Frenzy" assumption breaks.
- The exact byte layout of `dLighting` (SendLightingInformation), `paletteTranslation` and `overlays` is described only by name here, per the task's instruction to treat "object" as a known structure. I did confirm SendAnimation emits ANIMATE_TRANSLATION (which must be the value 9 that ExtractPaletteTranslation consumes rather than rewinds) immediately before the animation when GetBodyTranslation is nonzero (player.kod:9240-9243), but I did not enumerate ANIMATE_* numeric values or the overlay record layout.
- Whether the arena Watcher (TosWatcher) can veto an attack silently or always messages. Room ReqSomethingAttack delegates to `Send(oWatcher,@ReqSomethingAttack,...)` (room.kod:1230-1234) and I did not read TosWatcher's implementation, so the refusal text (if any) for an in-arena illegal attack is undetermined.
- Whether SomethingAttacked ever reaches the client. It is defined on Holder (kod/object/active/holder.kod:651-663) and raised by Battler (battler.kod:363), but User does not implement it, so I believe no packet is generated. I did not exhaustively grep every ancestor of User for an override, so a low-probability path may exist.
- The precise contents of the DeadBody `good` parameter's effect. Player CreateDeadBody passes #good=(piKarma>0) into &DeadBody (player.kod:8365-8412), which suggests a karma-dependent corpse appearance visible to everyone, but I could not locate the DeadBody class file (it is not at kod/object/item/passitem/deadbody.kod) and so did not confirm whether `good` changes the icon/overlay actually serialised to clients. If it does, a dead player's corpse is a public karma-sign oracle.
- Whether the client is ever told the server type (SERVER_NORMAL vs SERVER_NO_MURDER). I found no BP message carrying piServer_type. The only observable is behavioural: on a no-murder server the UC_SAFETY confirmation messages are suppressed entirely (user.kod:1545-1562), so a client that toggles safety and receives no BP_MESSAGE can infer IsPKAllowed is FALSE. I did not verify there is no other channel (e.g. a login-time BP_ADMIN or module load).
- Whether piKill_count / piKill_count_decay / piJustified_kill_count are exposed anywhere a client can read. GetUnjustifiedKills / GetDecayedUnjustifiedKills / GetJustifiedKills exist (player.kod:11720-11733) but I found no AddPacket path for them; the UC_LOOK_PLAYER extra-info block has a large commented-out "known for mastery" section (player.kod:1730-1776) that hints this area has been trimmed. I did not grep every caller of those three getters.


---

## Selling to NPC merchants, merchant pricing/mood, and the bank + vault (BP_REQ_OFFER / BP_COUNTEROFFER / BP_ACCEPT_OFFER, BP_REQ_DEPOSIT / BP_WITHDRAWAL_LIST / BP_REQ_WITHDRAWAL(_ITEMS), UC_DEPOSIT / UC_WITHDRAW / UC_BALANCE)

Selling to an NPC merchant goes entirely through the normal player-offer protocol: you send BP_REQ_OFFER(120) naming the merchant plus the item list; the merchant's `Monster.ReqOffer` (kod/object/active/holder/nomoveon/battler/monster.kod:2248) vets it, the server echoes BP_OFFERED(213) back to you, then `Monster.Offer` (monster.kod:3126) fabricates a &Money object out of thin air and sends it to you as BP_COUNTEROFFER(214) — that single object's amount IS the sale price. You then send BP_ACCEPT_OFFER(121) within 30 s, or BP_CANCEL_OFFER(122). Because the counteroffer arrives before you commit anything, BP_REQ_OFFER + read BP_COUNTEROFFER + BP_CANCEL_OFFER is a free, non-destructive price oracle — that is the only runtime way for an agent to learn an item's worth, since nothing in ExtractObject, the look description, or any other packet carries item value. Price arithmetic is dead simple and mood-independent: a merchant pays `Bound(GetValue(item) * (100 - 10*viMerchant_markup) / 100, 1, $)` per item and charges `GetInitValue(item) * (100 + 20*viMerchant_markup)/100 * factionBonus/100`, so a MERCHANT_BARGAIN buyer pays 90 % of value and a MERCHANT_RIPOFF one pays 50 %. There is no haggling and no mood effect on price; mood (piMood, -100..100) only gates which library speech lines an NPC will use, and merchants have infinite money (money is `Create`d on demand) and effectively infinite stock (items are sold as `Create(...,#model=i)` copies unless `vbSellFromInventory`). The vault is a separate 3000-bulk-per-player Storage object: BP_REQ_DEPOSIT(230) deposits in ONE round trip with no accept step (the deposit happens inside ReqOffer→ReqGive→VaultDeposit and then ReqOffer deliberately returns FALSE), BP_REQ_WITHDRAWAL(232) returns BP_WITHDRAWAL_LIST(231) of your stored items with retrieval fees, and BP_REQ_WITHDRAWAL_ITEMS(233) / BP_REQ_BUY_ITEMS(125) both just call `Monster.Buy`. The bank is cash-only via BP_USERCOMMAND(155) sub-opcodes 35/36/37, and the balance reply is not a structured packet at all — it is a BP_MESSAGE(32) chat line whose 4th parameter is the balance integer.

### Wire formats

**BP_REQ_OFFER (120) — client->server**

```
1 byte opcode = 120
4 bytes  merchant object id, little-endian ({4, TAG_OBJECT})
2 bytes  N = item count
then N times:
   4 bytes  item object id; top nibble = 1 (CLIENT_TAG_NUMBER) if the item is an &NumberItem stack, else 0
   4 bytes  amount  -- PRESENT ONLY IF the top nibble of the preceding id was 1
```

*blakserv/sprocket.c:48 (`{ BP_REQ_OFFER, { {4, TAG_OBJECT}, {2, LIST_OBJ_PARM}, {0, DONE_PARM} } }`); list parse blakserv/parsecli.c:276-315; scalar-object parse blakserv/parsecli.c:361-388; client encoder clientd3d/protocol.c:50 and 262-290; kod dispatch kod/object/active/holder/nomoveon/battler/player/user.kod:1126-1137*

DESYNC HAZARD on the leading {4,TAG_OBJECT} field: parsecli.c:378-388 inspects the top nibble of that field too, and if it is 1 the server consumes 4 EXTRA bytes as `number_stuff`. Always write the merchant id with top nibble 0. The server masks ids to the low 28 bits (v0_val_type `int data:28; unsigned tag:4`, include/bkod.h:211-216). The object list reaches kod REVERSED (parsecli.c:279-281 comment 'object lists will be in reverse order'); the amounts are Cons'd in the same pass so #number_list stays element-aligned with the reversed #item_list. The client culls entries whose temp_amount <= 0 BEFORE writing the 2-byte count (clientd3d/protocol.c:271-289). kod rejects the whole message if any amount < 1 (user.kod:4938-4948).

**BP_OFFERED (213) — server->client**

```
1 byte opcode = 213
2 bytes  N = count
then N times:  object          <-- the standard "object" payload (ToCliObject)
```

*kod/.../player/user.kod:4993-5000 (`AddPacket(1,BP_OFFERED,2,Length(plOffer_items)); for i in plOffer_items { Send(self,@ToCliObject,#what=i); }`); client clientd3d/server.c:1057-1066 HandleOffered -> ExtractObjectList (server.c:414-436)*

This is the echo of YOUR OWN offer, sent only AFTER the merchant's ReqOffer returned TRUE. Items that are &NumberItem appear with id top-nibble 1 followed by amount(4) (user.kod:2339-2346). ExtractObjectList requires the remaining length to be consumed EXACTLY or it returns LIST_ERROR and the whole message is rejected. If the merchant refuses, this packet never arrives AND no BP_OFFER_CANCELED is sent — you get only a BP_MESSAGE.

**BP_COUNTEROFFER (214) — server->client**

```
1 byte opcode = 214
2 bytes  N = count (always 1 from an NPC buyer)
then N times:  object          <-- the standard "object" payload

For an NPC merchant the single object is a freshly created &Money, i.e.:
   4 bytes id with top nibble = 1
   4 bytes amount   <-- THIS IS THE SALE PRICE IN SHILLINGS
   4 bytes iconRsc, 4 nameRsc, 4 flags, 4 rarity, dLighting, paletteTranslation, animation, overlays
```

*kod/.../player/user.kod:5365-5382 (`AddPacket(1,BP_COUNTEROFFER,2,Length(item_list))`); produced by kod/.../battler/monster.kod:3145-3146 (`plOffer_items = [ Create(&Money,#number=iValue_offered) ]; Send(what,@CounterOffer,#item_list=plOffer_items);`); client clientd3d/server.c:1079-1088*

Money is a NumberItem so the amount field is always present. Receiving this also sets pbOffer_OtherAccepted = TRUE on your user object (user.kod:5378), which is the gate that lets BP_ACCEPT_OFFER succeed (user.kod:5518-5528). Reading this and then cancelling costs nothing — this is the price oracle.

**BP_ACCEPT_OFFER (121) — client->server**

```
1 byte opcode = 121   (no payload at all)
```

*blakserv/sprocket.c:52 (`{ BP_ACCEPT_OFFER, { {0, DONE_PARM} } }`); kod dispatch user.kod:1157-1162 -> UserAcceptOffer user.kod:5507*

Fails with BP_MESSAGE user_cant_acceptoffer if poOffer_who = $ (user.kod:5511-5515). Fails silently-ish (Debug + CancelIfOffer, which DOES send BP_OFFER_CANCELED) if pbOffer_OtherAccepted is FALSE, i.e. if you accept before the counteroffer arrived (user.kod:5518-5528).

**BP_CANCEL_OFFER (122) — client->server**

```
1 byte opcode = 122   (no payload)
```

*blakserv/sprocket.c:50; kod dispatch user.kod:1141-1146 -> UserCancelOffer user.kod:5211-5225*

Safe abort. Sends @OfferCanceled to the merchant (which kills its 30 s timer, monster.kod:3164-3179) and calls CleanupCancelOffer (user.kod:5227-5243) which Deletes the temporary NumberItem copies. CleanupCancelOffer itself sends NO packet.

**BP_OFFER_CANCELED (212) — server->client**

```
1 byte opcode = 212   (client requires len == 0)
```

*kod/.../player/user.kod:5257-5261, 5268-5272, 5355-5358, 5649-5651; client clientd3d/server.c:1048-1055 (`if (len != 0) return false;`)*

Sent when the OTHER side cancels, when your own accept is rejected, and — confusingly — at the end of a SUCCESSFUL AcceptOffer on the passive side purely to make the client dialog disappear (user.kod:5648-5651, comment `% Send a "cancelled" to make dialog go away`). Do not treat this as failure without checking whether you got your money.

**BP_OFFER (211) — server->client**

```
1 byte opcode = 211
object                       <-- the offerer, standard "object" payload
2 bytes N = count
N times: object              <-- the offered items
```

*kod/.../player/user.kod:5197-5205; client clientd3d/server.c:1028-1046 HandleOffer*

PLAYER-TO-PLAYER ONLY. An NPC merchant never sends this; Monster.ReqOffer/Monster.Offer are kod-internal, so a merchant sale produces BP_OFFERED then BP_COUNTEROFFER with no BP_OFFER in between.

**BP_REQ_COUNTEROFFER (123) — client->server**

```
1 byte opcode = 123
2 bytes N = count
N times: 4 bytes item id [+ 4 bytes amount if top nibble == 1]
```

*blakserv/sprocket.c:51; kod dispatch user.kod:1148-1155 -> UserCounterOffer user.kod:5280*

DO NOT USE against an NPC merchant. UserCounterOffer does `Send(poOffer_who,@CounterOffer,...)` (user.kod:5375) and class Monster has no CounterOffer handler (only a Send at monster.kod:3146), so SendBlakodMessage logs 'can't find a handler' and returns NIL (blakserv/sendmsg.c:400-404). NIL is falsy, so the server calls CleanupCancelOffer and sends BP_OFFER_CANCELED — your sale is aborted.

**BP_COUNTEROFFERED (215) — server->client**

```
1 byte opcode = 215
2 bytes N
N times: object
```

*kod/.../player/user.kod:5345-5352; client clientd3d/server.c:1068-1077*

Echo of your own counteroffer. Never appears in a merchant sale.

**BP_REQ_BUY (124) — client->server**

```
1 byte opcode = 124
4 bytes  merchant/vaultman object id
```

*blakserv/sprocket.c:55; kod dispatch user.kod:1179-1184 -> UserBuy user.kod:5690-5724*

Also works on a MOB_VAULTMAN, in which case the returned BP_BUY_LIST enumerates YOUR STORED ITEMS with GetVaultRetrievalFee instead of prices (user.kod:5706-5713). UserBuy performs no same-room check; the same-room check lives in Monster.Buy (monster.kod:3688-3696).

**BP_BUY_LIST (216) — server->client**

```
1 byte opcode = 216
object                       <-- the seller, standard "object" payload
2 bytes N = count
then N times:
   object                    <-- the item/skill/spell, standard "object" payload
   4 bytes cost (SIZE_COST)
```

*kod/.../player/user.kod:5701-5721; client clientd3d/server.c:1157-1193 HandleBuyList*

cost = Monster.GetPrice (monster.kod:4880) for a normal seller, or Monster.GetVaultRetrievalFee for a vaultman. NOTE the client's trailing length check is disabled (`len -= (ptr - start); if (0)` at server.c:1180-1186) — a desync here is silent.

**BP_REQ_BUY_ITEMS (125) — client->server**

```
1 byte opcode = 125
4 bytes  merchant object id
2 bytes  N
N times: 4 bytes item id [+ 4 bytes amount if top nibble == 1]
```

*blakserv/sprocket.c:56; kod dispatch user.kod:1186-1194 -> UserBuyItems user.kod:5804-5820 -> Monster.Buy monster.kod:3682*

Identical in effect to BP_REQ_WITHDRAWAL_ITEMS(233) — both just Send @Buy. Amounts are clamped to Bound(iAmount,1,MAX_BUY_AMOUNT=500), or to the merchant's on-hand count when vbSellFromInventory (monster.kod:3740-3755).

**BP_REQ_DEPOSIT (230) — client->server**

```
1 byte opcode = 230
4 bytes  vaultman-or-banker object id
2 bytes  N
then N times:
   4 bytes  item object id; top nibble 1 for &NumberItem stacks
   4 bytes  amount  -- only if top nibble == 1
```

*blakserv/sprocket.c:49 (`{ BP_REQ_DEPOSIT, { {4, TAG_OBJECT}, {2, LIST_OBJ_PARM}, {0, DONE_PARM} } }`); kod dispatch user.kod:1213-1221 -> UserDeposit user.kod:5006-5077*

ONE-SHOT: there is NO accept step. The deposit is actually performed inside Monster.ReqOffer -> Monster.ReqGive -> Monster.VaultDeposit (monster.kod:2436-2440, 3210) and ReqGive then returns TRUE, which makes ReqOffer return FALSE (monster.kod:2311-2315), which makes UserDeposit call CleanupCancelOffer and stop. Consequence: you get NO BP_OFFERED and NO BP_OFFER_CANCELED — only BP_MESSAGE lines from SayToOne. Accepted targets: MobIsVaultman (any items), or MobIsBanker with EXACTLY one item that IsClass &Money (user.kod:5035-5042).

**BP_REQ_WITHDRAWAL (232) — client->server**

```
1 byte opcode = 232
4 bytes  vaultman object id
```

*blakserv/sprocket.c:57; kod dispatch user.kod:1196-1201 -> UserWithdrawal user.kod:5728-5752*

HAZARD: UserWithdrawal only builds a packet `if Send(what,@MobIsVaultman)` but calls SendPacket(poSession) unconditionally (user.kod:5740-5750). Against a non-vaultman seller with a non-empty for-sale list, SendPacket is reached with blist == NULL (blakserv/commcli.c:181-195). Do not point BP_REQ_WITHDRAWAL at anything other than a MOB_VAULTMAN. Returns nothing at all if GetForSale is NIL.

**BP_WITHDRAWAL_LIST (231) — server->client**

```
1 byte opcode = 231
object                       <-- the vaultman, standard "object" payload
2 bytes N = count
then N times:
   object                    <-- one stored item, standard "object" payload
   4 bytes retrieval fee (SIZE_COST)
```

*kod/.../player/user.kod:5741-5749; client clientd3d/server.c:1195-1226 HandleWithdrawalList; item source Monster.AssembleVaultList monster.kod:4797-4811 -> Storage.GetItemsStored kod/object/passive/storage.kod:163-176*

Unlike HandleBuyList, this handler DOES enforce `if (len != 0) return false` (server.c:1218-1223), so a byte-count mistake here fails loudly. Fee comes from GetVaultRetrievalFee (0 by default, 1 per item in Kocatan).

**BP_REQ_WITHDRAWAL_ITEMS (233) — client->server**

```
1 byte opcode = 233
4 bytes  vaultman object id
2 bytes  N
N times: 4 bytes stored-item id [+ 4 bytes amount if top nibble == 1]
```

*blakserv/sprocket.c:58; kod dispatch user.kod:1203-1211 -> UserWithdrawalItems user.kod:5822-5837 -> Monster.Buy monster.kod:3682 -> Monster.VaultWithdraw monster.kod:3316*

Functionally identical to BP_REQ_BUY_ITEMS(125). Monster.Buy routes vaultmen to VaultWithdraw before any purchase logic (monster.kod:3702-3709).

**BP_USERCOMMAND / UC_DEPOSIT (155) — client->server**

```
1 byte  BP_USERCOMMAND = 155
1 byte  sub-opcode UC_DEPOSIT = 35
4 bytes amount, little-endian ({4, TAG_INT})
```

*blakserv/sprocket.c:126 (`{ UC_DEPOSIT, { {4, TAG_INT}, {0, DONE_PARM} } }`); sub-opcode framing blakserv/parsecli.c:142-152; opcode numbers kod/include/protocol.khd:108, 201; kod dispatch user.kod:1885-1893; handler Monster.SomeoneTryUserCommand monster.kod:5112-5122 -> Monster.BankDeposit monster.kod:3532*

HAZARD: same 4-byte top-nibble trap as TAG_OBJECT — parsecli.c:378-388 checks in_val.v.tag on any 4-byte field, so amounts >= 0x10000000 (268435456) will make the server eat 4 extra bytes. Also kod ints are 28-bit (MAX_KOD_INT = 0x07ffffff, include/bkod.h:207). Amount <= 0 is silently ignored (monster.kod:3540-3543).

**BP_USERCOMMAND / UC_WITHDRAW (155) — client->server**

```
1 byte  155
1 byte  UC_WITHDRAW = 36
4 bytes amount
```

*blakserv/sprocket.c:128; kod dispatch user.kod:1896-1904; handler monster.kod:5124-5134 -> Monster.BankWithdraw monster.kod:3588*

BankWithdraw first does WithdrawAccount(#what=who) with amount omitted, which removes the ENTIRE balance (kod/object/passive/bank.kod:76-99, `If <amount> = $, then withdraw all`), then re-deposits the remainder. If you ask for more than your balance it re-deposits everything and refuses. If you cannot carry it all, it silently reduces `amount` to what fits and re-deposits the rest (monster.kod:3648-3655).

**BP_USERCOMMAND / UC_BALANCE (155) — client->server**

```
1 byte  155
1 byte  UC_BALANCE = 37
(no further payload)
```

*blakserv/sprocket.c:127 (`{ UC_BALANCE, { {0, DONE_PARM} } }`); kod dispatch user.kod:1907-1915; handler monster.kod:5136-5141 -> Monster.BankBalance monster.kod:3458-3480*

Works on a MOB_BANKER *or* MOB_VAULTMAN room-mate (the guard at monster.kod:5102-5105 admits both), but BankBalance itself returns immediately unless MobIsBanker (monster.kod:3462-3465), so a vaultman swallows the command and answers nothing.

**BP_MESSAGE (the balance / deposit / withdraw / refusal reply) (32) — server->client**

```
1 byte  opcode = 32
4 bytes message resource id  = monster_say_to_one  ("~k%s%s tells you, \"%s~n~k\"")
4 bytes parm1 = merchant GetCapDef      (resource id, STANDARD_RESOURCE width 4)
4 bytes parm2 = merchant GetName        (resource id)
4 bytes parm3 = the INNER message resource id, e.g. Lm_bnkr_balance
4 bytes parm4 = the integer, e.g. the account balance
(further parms only if the inner message uses them)
```

*kod/.../player/user.kod:3207-3262 MsgSendUser (`AddPacket(1,BP_MESSAGE,4,message_rsc)` then one AddPacket per non-NIL parm); Monster.SayToOne monster.kod:5205-5224; resources monster.kod:176 (monster_say_to_one), 136 (Lm_bnkr_balance = "You have %i shillings in your account."), 137-138 (Lm_bnkr_did_deposit), 144-145 (Lm_bnkr_did_withdraw); widths kod/include/protocol.khd:219-224 (STANDARD_RESOURCE = 4, NUMBER_OBJECT = 5, STRING_RESOURCE = 6); BP_MESSAGE = 32 at protocol.khd:18*

THERE IS NO STRUCTURED BALANCE REPLY. The balance is byte offset 17..20 of the BP_MESSAGE body (1+4+4+4+4). Parameters are OMITTED entirely when NIL, so parameter position is not fixed across different inner messages — you must switch on parm3 (the inner resource id) to know how to read the rest. Note SayToOne can arrive via Post (deferred one tick) for BankBalance/Lm_bnkr_no_account but via Send (immediate) for Lm_bnkr_did_deposit / Lm_bnkr_did_withdraw. Merchant sale refusals arrive the same way: Lm_buyer_unwanted ("I'm not interested."), Lm_buyer_no_value, Lm_buyer_offer_busy, Lm_buyer_timeout (monster.kod:130-135).

### Rules, in the order the server checks them

| | rule | where |
|---|---|---|
| message | Selling is the offer protocol, not a dedicated sell opcode. There is no BP_REQ_SELL. You must use BP_REQ_OFFER(120) -> read BP_COUNTEROFFER(214) -> BP_ACCEPT_OFFER(121). | `kod/.../player/user.kod:4917-5002 UserOffer; kod/.../battler/monster.kod:2248 ReqOffer, 3126 Offer, 3181 AcceptOffer; blakserv/sprocket.c:48-52 (no sell entry anywhere in client_def_table)` |
| **silent** | Client-side pre-check (order 1): every offered item must be directly owned by you and the list must contain no duplicate ids. A duplicate is logged as an ALERT and the whole message is dropped. | `kod/.../player/user.kod:4921-4938 (`if lObjects <> $ AND FindListElem(lObjects,i) <> 0 { Debug("ALERT! ...tried to offer a duplicate item..."); return FALSE; }` then `if Send(i,@GetOwner) <> self { return FALSE; }`)` |
| **silent** | Order 2: every entry in #number_list must be >= 1, else the message is dropped with a Debug line. | `kod/.../player/user.kod:4940-4949 (`Debug("Bad offer quantity", i, "from user", self); return FALSE;`)` |
| message | Order 3: you must not already be in an offer (poOffer_who = $) and the target must answer TRUE to @CanAcceptOffer. For a Monster that means (MOB_BUYER | MOB_RECEIVE); Object.CanAcceptOffer defaults to FALSE for everything else. | `kod/.../player/user.kod:4951-4959; kod/.../battler/monster.kod:2243-2246 (`return ((viAttributes & MOB_BUYER) OR (viAttributes & MOB_RECEIVE));`); kod/object.kod:702-707` |
| **silent** | Order 4: if you are in an arena room, Room.CanOffer must permit it. | `kod/.../player/user.kod:4961-4965` |
| **silent** | Order 5 (merchant side, ReqOffer): item_list must be non-NIL and the merchant's owner (room) must equal yours. A distant offer is logged as an ALERT. There is NO distance or line-of-sight check inside the room. | `kod/.../battler/monster.kod:2255-2270 (`if Send(what,@GetOwner) <> poOwner { Debug("ALERT! ...offered items to NPC...from distant RID"); return FALSE; }`)` |
| message | Order 6: EVERY item must answer TRUE to @CanBeGivenToNPC. Any item carrying the IA_MADE attribute is refused, as are black daggers, hunting swords, spirit hammers, unique weapons, necromantic amulets and secure room keys. One bad item kills the whole offer. | `kod/.../battler/monster.kod:2272-2280; kod/object/item.kod:1110-1127 (IA_MADE kludge); kod/object/item/passitem/weapon/unique.kod:117-121, .../bkdagger.kod:628, .../huntsw.kod:785, .../spirhamm.kod:143, kod/object/item/actitem/necroam.kod:981, kod/object/item/passitem/roomkeyc.kod:80` |
| message | Order 7: every item must pass @ReqLeaveHold on you (i.e. @ReqLeaveOwner plus every active object in your inventory agreeing via @ReqSomethingLeft) — this is what blocks cursed/bonded/equipped items. | `kod/.../battler/monster.kod:2282-2288 and again at 2337-2343; kod/object/active/holder.kod:371-390` |
| **silent** | Order 8: active quest nodes get first refusal. If any plActiveQuestNodes @CheckCompletionCriteria claims an item, ReqOffer returns FALSE and the sale does not happen (the quest consumed it instead). | `kod/.../battler/monster.kod:2290-2300` |
| **silent** | Order 9: if the merchant has MOB_RECEIVE, the gift path runs FIRST. Monster.ReqGive is called; if it returns TRUE, ReqOffer returns FALSE (no sale). If the NPC is not also MOB_BUYER, ReqOffer returns FALSE unconditionally — a pure MOB_RECEIVE NPC eats gifts, it does not buy. | `kod/.../battler/monster.kod:2302-2320; Monster.ReqGive monster.kod:2374-2442` |
| message | Order 10: the merchant must not already have a customer (poCustomer = $), else you are told it is busy. | `kod/.../battler/monster.kod:2324-2331` |
| message | Order 11: EVERY item must pass @ObjectDesired. The base implementation returns TRUE (a bare MOB_BUYER buys anything), but almost every real merchant overrides it to only accept the categories it deals in. One undesired item rejects the entire offer. | `kod/.../battler/monster.kod:2345-2351 and base at 4707-4713 (`return TRUE;`); category helpers IsObjectWeapon monster.kod:4142, IsObjectSundry 4149, IsObjectMisc 4165, IsObjectWearable 4183, IsObjectGem 4197, IsObjectReagent 4213; examples: kod/.../barlqtwn/bqSmith.kod:48-55 (wearable OR misc OR weapon), .../barlqtwn/bqmerch.kod:113-128 (gems OR sundry, and refuses NumberItem stacks > 25), .../hazartwn/hzapoth.kod:55-60 (reagents OR gems), .../kocatwn/kcmerch.kod:52-56 (`return TRUE`), .../kocatwn/kcshopk.kod:209-260 (refuses Money, IA_BONDED, ITEMTYPE_SPECIAL, Token, Totem, duplicates of stock, and stock > MAX_FORSALE=25)` |
| message | Order 12: the sum of raw @GetValue over the offer must be non-zero. | `kod/.../battler/monster.kod:2353-2360` |
| message | Order 13: @IsCustomerOkay. A MOB_LAWFUL merchant will not deal with a PFLAG_MURDERER while more than one non-DM Player is in the room; with only you present it grumbles and serves you anyway. The Parliament faction override GetFactionSellToMurderer can bypass this. | `kod/.../battler/monster.kod:2362-2366 and 5062-5098` |
| message | After the counteroffer you have exactly viCancel_offer_time = 30000 ms to send BP_ACCEPT_OFFER. On timeout the merchant cancels both sides. | `kod/.../battler/monster.kod:208 (`viCancel_offer_time = 30000`), 3147 (CreateTimer), 3153-3161 CancelOfferTimer` |
| message | BP_ACCEPT_OFFER is refused unless pbOffer_OtherAccepted is TRUE, which is only set when a BP_COUNTEROFFER was delivered to you. Accepting early is logged as an ALERT and cancels the offer. | `kod/.../player/user.kod:5378 (set in User.CounterOffer), 5518-5528 (`Debug("ALERT! Player ... tried complete an offer without the other person accepting."); Send(self,@CancelIfOffer);`)` |
| message | At accept time CheckOfferStuff re-verifies each offered item: @ReqNewOwner, @ReqNewOwnerAttributes(type=1), that you still hold it (and hold enough of a NumberItem stack), and that the recipient can carry the total weight and bulk. | `kod/.../player/user.kod:5387-5484` |
| message | MERCHANTS NEVER RUN OUT OF MONEY. Payment is `Create(&Money,#number=iValue_offered)` — money is fabricated, never drawn from a merchant purse. | `kod/.../battler/monster.kod:3145 (`plOffer_items = [ Create(&Money,#number=iValue_offered) ];`); identical in kod/object/active/holder/nomoveon/pawnman.kod:90` |
| message | MERCHANT STOCK IS EFFECTIVELY INFINITE unless vbSellFromInventory is TRUE. Normal sellers hand out `Create(GetClass(i),#model=i)` copies and never remove the template from plFor_sale; only the two vbSellFromInventory NPCs (Kocatan Shopkeeper 'Pacal', wanderer Izzio) actually delete stock, and those two restock from a 12-24 h timer. | `kod/.../battler/monster.kod:238 (`vbSellFromInventory = FALSE`), 3798-3840 (copy vs. DelListElem branch); vbSellFromInventory=TRUE only at kod/.../kocatwn/kcshopk.kod:54 and kod/.../wanderer/izzio.kod:54; restock kcshopk.kod:185 (`ptNew_Junk = CreateTimer(self,@AddNewJunkToSell,(Random(12,24)*60*60*1000))`), izzio.kod:114-145` |
| **silent** | THERE IS NO HAGGLING. Grep for haggle/haggling/appraise/appraisal over the whole kod tree returns nothing. BP_REQ_COUNTEROFFER exists but a Monster has no CounterOffer handler, so it cannot be used to negotiate — it aborts the sale. | `empty result for `grep -rni "haggle|haggling|appraise|appraisal" kod/`; kod/.../battler/monster.kod has @CounterOffer only as a Send at 3146, never as a message definition; blakserv/sendmsg.c:400-404 returns NIL for an unhandled message` |
| **silent** | MOOD NEVER CHANGES A PRICE. GetPrice (monster.kod:4880-4912), Offer (3126-3151), GetVaultDepositFee/GetVaultRetrievalFee (3304-3313) and their only override (kcvaultm.kod:91-101) contain no reference to piMood. piMood is read in exactly two places server-wide: GetMood/GetMoodFlags for library speech filtering, and LIBACT_MOOD to change itself. | `kod/.../battler/monster.kod:5587-5605; only readers are kod/util/library.kod:2103-2108 (`if (( libvec & LIBRES_MOOD_MASK ) & send( mob, @GetMoodFlags )) = 0 { return TRUE; }` in PersonalityClash) and kod/util/library.kod:2846-2855 (LIBACT_MOOD)` |
| **silent** | Mood also does not gate willingness to buy or sell: MOOD is not consulted in ReqOffer, Offer, ObjectDesired, Buy or IsCustomerOkay. Its only functional effect is which library speech line an NPC picks (LIBRES_MOOD_GOOD if piMood > 10, LIBRES_MOOD_BAD if piMood < -10, else LIBRES_MOOD_NEUTRAL), which can indirectly gate a LIBACT_CONDITIONAL that adds a fixed-price item to the conditional sale list. | `kod/.../battler/monster.kod:5593-5606; kod/util/library.kod:2856-2867 (LIBACT_CONDITIONAL -> AddToConditionalList); Monster.GetPrice returns the hard-coded conditional price bypassing markup entirely (monster.kod:4886-4894)` |
| **silent** | BP_REQ_DEPOSIT completes in one round trip with no accept step, and deliberately returns FALSE afterwards. Do not wait for BP_OFFERED or BP_OFFER_CANCELED. | `kod/.../player/user.kod:5062-5070 (`if not Send(what,@ReqOffer,...) { Send(self,@CleanupCancelOffer); return; }`); the work happens at kod/.../battler/monster.kod:2436-2440 (`% Last chance. Am I a vaultman? ... Send(self,@VaultDeposit,...); return TRUE;`) which forces ReqOffer's `if Send(self,@ReqGive,...) { return FALSE; }` at 2311-2315` |
| message | Vault deposit refuses: zero-bulk items (i.e. gold), items failing @ReqLeaveHold, items failing @CanBeStoredInVault (unique weapons, tokens), insufficient cash for the fee, and a full locker (per-player bulk > piCapacity, default 3000). | `kod/.../battler/monster.kod:3222-3285; kod/object/passive/storage.kod:31 (`piCapacity = 3000`), 84-100 CanDepositItems; kod/object/item/passitem/weapon/unique.kod:109-114` |
| message | Vault withdrawal refuses if you have no safe box, if you named something not in your box, if a NumberItem count exceeds what is stored, if you cannot pay the retrieval fee, or if the bulk would exceed your GetBulkMax. | `kod/.../battler/monster.kod:3336-3418` |
| **silent** | UC_DEPOSIT / UC_WITHDRAW / UC_BALANCE are broadcast to every active object in your CURRENT ROOM and the first one that returns TRUE wins. No distance check. A MOB_VAULTMAN returns TRUE for UC_DEPOSIT and UC_WITHDRAW while doing NOTHING, so a vaultman standing in the same room as a banker will swallow your cash deposit. | `kod/.../player/user.kod:1885-1915 (`Send(poOwner,@SomeoneTryUserCommand,...)`); kod/object/active/holder.kod:828-842 (first TRUE wins); kod/.../battler/monster.kod:5100-5143, specifically 5112-5117 and 5124-5129 (`if (viAttributes & MOB_VAULTMAN) { return TRUE; }` with no action)` |
| message | Bank accounts are per-(player, bank-id) integers with no interest, no fee and no cap other than kod's 28-bit int. A player's account is wiped by system-level FixMoney/WithdrawAccount(#amount=$). | `kod/object/passive/bank.kod:56-74 DepositAccount, 76-99 WithdrawAccount, 102-114 GetAccount, 116-129 FixMoney; kod/util/system.kod:3922` |
| **silent** | A banker also secretly reports your balance to the Investigator if you are flagged suspect, on every deposit and withdrawal. | `kod/.../battler/monster.kod:3578-3582 and 3671-3675 (`if Send(SYS,@IsSuspect,#who=who) { Send(self,@ReportBankBalance,#who=who); }`), 3482-3530 ReportBankBalance` |
| **silent** | ITEM VALUE IS NOT DISCOVERABLE FROM ANY OTHER PACKET. The standard object payload carries iconRsc, nameRsc, flags and rarity but no value. Item.ShowDesc emits only the description template plus attribute and condition prose. No skill, spell or admin-free command reveals value. | `kod/object/item.kod:363-369 ShowDesc, 143-200 AppendDesc (condition prose only), 715-756 GetRarity (attribute-count grade, not value); kod/.../player/user.kod:2331-2440 ToCliObject (rarity at 2429-2435, no value field anywhere)` |

### Constants

- `MERCHANT_FLAT` = 0 — `kod/include/blakston.khd:1369`
- `MERCHANT_BARGAIN` = 1 — `kod/include/blakston.khd:1370`
- `MERCHANT_DISCOUNT` = 2 — `kod/include/blakston.khd:1371`
- `MERCHANT_NORMAL` = 3 — `kod/include/blakston.khd:1372`
- `MERCHANT_EXPENSIVE` = 4 — `kod/include/blakston.khd:1373`
- `MERCHANT_RIPOFF` = 5 — `kod/include/blakston.khd:1374`
- `viMerchant_markup default` = MERCHANT_NORMAL (3) — `kod/object/active/holder/nomoveon/battler/monster.kod:207`
- `SELL-TO-MERCHANT price, per item (the money you receive)` = iAdd = Bound( Send(item,@GetValue) * (100 - 10*viMerchant_markup) / 100 , 1, $ ); total = sum over items. Integer division truncates per item, and each item pays at least 1. NO faction bonus, NO mood, NO haggle. Multipliers by markup: FLAT 100%, BARGAIN 90%, DISCOUNT 80%, NORMAL 70%, EXPENSIVE 60%, RIPOFF 50%. — `kod/object/active/holder/nomoveon/battler/monster.kod:3131-3143 (`x = Send(i,@GetValue) * (100 - 10*viMerchant_markup) / 100; iAdd = Bound(x,1,$);`) and the comment at 3130-3131 ("The Faction Pricing bonus was selling items to NPCs at higher prices than the new price. This has been taken out.")`
- `BUY-FROM-MERCHANT price (what you pay)` = x = Send(item,@GetInitValue) * (100 + 20*viMerchant_markup) / 100; y = Parliament.GetFactionPriceBonus(who, buying=TRUE); return Bound(x*y/100, 1, $). Multipliers by markup: FLAT 100%, BARGAIN 120%, DISCOUNT 140%, NORMAL 160%, EXPENSIVE 180%, RIPOFF 200%. Note it uses GetInitValue (pristine value), NOT GetValue — condition does not discount a purchase. Skills and spells return Send(what,@GetValue) with no markup. Conditional-sale items short-circuit to their hard-coded price. — `kod/object/active/holder/nomoveon/battler/monster.kod:4880-4912; conditional short-circuit at 4886-4894; faction bonus kod/util/parlia.kod:1144-1177`
- `Item.GetValue (the number the sell formula multiplies)` = iPercent = (100 * piHits_init * piHits) / (viHits_init_max * viHits_init_max); iFinal = (GetInitValue() * iPercent) / 100; iFinal = Bound(iFinal, 10, GetInitValue()); then each item attribute applies @AdjustPrice. Because Bound applies min BEFORE max (C_Bound), an item whose GetInitValue < 10 keeps its small value rather than being floored to 10. — `kod/object/item.kod:408-448; blakserv/ccode.c:1999-2039 C_Bound`
- `Item.GetInitValue` = viValue_average, default 10. Only override in the tree is red canvas pants (viValue_average/2). — `kod/object/item.kod:403-406 and 69 (`viValue_average = 10`); override kod/object/item/passitem/defmod/pants/pantsc.kod:58-66`
- `NumberItem.GetValue / Money.GetValue` = piNumber * GetInitValue(). Money viValue_average = 1, so a Money object's value equals its count. — `kod/object/item/passitem/numbitem.kod:178-181; kod/object/item/passitem/numbitem/money.kod:49-52 and 38`
- `ItemAtt.AdjustPrice` = return (value * (piValue_Modifier + piValue_power_modifier*power)) / 100. Documented range: attributes raise price 150/200/250 %, curses drop it to 50 %. ItemAtt IA_MADE returns -1 (and IA_MADE items cannot be given to an NPC at all). — `kod/object/passive/itematt.kod:538-564; kod/object/passive/itematt/iamade.kod:118-121; kod/object/item.kod:1110-1127`
- `GetFactionPriceBonus` = 100 for everyone except FACTION_PRINCESS, which gets 95 when buying and 105 when selling — but the selling side is never called (see monster.kod:3130 comment), so the only live effect is a 5 % discount on purchases. — `kod/util/parlia.kod:1144-1177`
- `viCancel_offer_time` = 30000 ms — `kod/object/active/holder/nomoveon/battler/monster.kod:208`
- `MAX_BUY_AMOUNT` = 500 — `kod/include/blakston.khd:2480`
- `MAX_FORSALE / NUMBER_ITEM_MAX (inventory-selling shopkeepers only)` = 25 / 5500 — `kod/.../monster/towns/kocatwn/kcshopk.kod:18,21; kod/.../monster/towns/wanderer/izzio.kod:22`
- `MOODMOD_* (the `why` argument to AffectMood)` = ACCEPT_ITEM=1, ACCEPT_RENT=2, DAWN=3, DUSK=4, SELL_ITEM=5, SELL_GHALL=6, FACTION_CHANGE=7, BANK_DEPOSIT=8, BANK_WITHDRAWAL=9, VAULT_DEPOSIT=10, VAULT_WITHDRAWAL=11, WANDERER_ENTERED=12 — `kod/include/blakston.khd:1354-1365`
- `Where AffectMood is actually fired` = MOODMOD_ACCEPT_ITEM in GotWantedItem (gift path only, monster.kod:2474); DAWN at Meridian hour 6 and DUSK at hour 18 (monster.kod:2984-2993); VAULT_DEPOSIT (3299); BANK_DEPOSIT (3578); BANK_WITHDRAWAL (3672); VAULT_WITHDRAWAL (3708, on the Buy path); SELL_ITEM after a player BUYS an item (3846). NOTHING fires AffectMood on the MOB_BUYER sell-to-merchant path — selling loot to a merchant does not move its mood at all. — `kod/object/active/holder/nomoveon/battler/monster.kod:2474, 2986, 2992, 3299, 3578, 3672, 3708, 3846; base AffectMood is a no-op at 399-403`
- `Mood bounds and decay` = SetMood/ChangeMood clamp to [-100, 100]. AmbientLightChanged fires every Meridian hour (5 real minutes); every 4th Meridian hour (20 real minutes) if piMood is outside [-5,5] it moves halfway back: iMoodMod = ((abs(piMood) - 5) / 2) * (piMood / abs(piMood)); SetMood(piMood - iMoodMod). — `kod/object/active/holder/nomoveon/battler/monster.kod:5608-5620 and 2977-3008`
- `Mood -> speech flags` = piMood < -10 => LIBRES_MOOD_BAD (0x400); piMood > 10 => LIBRES_MOOD_GOOD (0x100); otherwise LIBRES_MOOD_NEUTRAL (0x200). LIBRES_MOOD_MASK = 0x00F00. — `kod/object/active/holder/nomoveon/battler/monster.kod:5593-5606; kod/include/blakston.khd:1345-1351`
- `LIBACT_MOOD` = 21 — a speech-keyword action that does Post(mob,@SetMood,#new_mood=GetMood()+delta). Known deltas run -5..+5, e.g. Kocatan Weapons Master 'customs' +5 / 'blind' -5; Kocatan Shopkeeper 'sell' +2; Tos Banker 'shillings' +1; Minstrel 'freebird' +4 / 'duke' -3. — `kod/include/blakston.khd:1321; kod/util/library.kod:2846-2855; keyword tables kod/util/library.kod:1316-1400`
- `Speech spam list (limits mood farming)` = A keyed library line only fires once until plSpamList is cleared, which happens on every RandomTimer tick (CreateTimer at viRandom_delay * Random(2,5)/2). So mood keywords are repeatable, just rate-limited. — `kod/object/active/holder/nomoveon/battler/monster.kod:2871-2910 (OnSpamList/AddToSpamList), 3013-3018 (`% Clear spam list  plSpamList = $;` in RandomTimer), 3168-3170; gate in kod/util/library.kod:2271-2283`
- `MOB_* attribute bits relevant here` = MOB_RECEIVE=0x00020 (takes gifts), MOB_BUYER=0x00040 (buys items), MOB_SELLER=0x00080, MOB_BANKER=0x00100, MOB_TEACHER=0x00400, MOB_COND_SELLER=0x10000, MOB_LAWFUL=0x40000, MOB_VAULTMAN=0x80000 — `kod/include/blakston.khd:1394-1408`
- `Client-visible flags that identify a trade partner` = OFFER_YES = 0x00000200 set when (MOB_BUYER | MOB_RECEIVE); BUY_YES = 0x00000400 set when MobIsSeller (MOB_SELLER | MOB_COND_SELLER | MOB_TEACHER). These arrive in the 4-byte flags field of the object payload. C-side names OF_OFFERABLE / OF_BUYABLE. — `kod/include/blakston.khd:74-77; kod/object/active/holder/nomoveon/battler/monster.kod:5168-5193; include/proto.h:363-364`
- `Vault capacity` = Storage.piCapacity = 3000 bulk per player, checked as (already-stored bulk + new bulk) > piCapacity. — `kod/object/passive/storage.kod:31 and 84-100`
- `Vault fees` = Default deposit fee = Send(what,@GetBulk) (1 gp per stone); default retrieval fee = 0. Kocatan vaultman charges 2*GetBulk to deposit and 1 flat per item to retrieve. — `kod/object/active/holder/nomoveon/battler/monster.kod:3304-3313; kod/.../monster/towns/kocatwn/kcvaultm.kod:91-101`
- `Packet width tags used by AddPacket` = STANDARD_RESOURCE = 4 (4-byte resource id), NUMBER_OBJECT = 5 (4 bytes with CLIENT_TAG_NUMBER=1 in the top nibble), STRING_RESOURCE = 6 (2-byte length + resolved string) — `kod/include/protocol.khd:218-224; blakserv/commcli.c:20-21, 85-92`
- `CLIENT_TAG_NUMBER` = 1 (CLIENT_TAG_NORMAL = 0) — `include/proto.h:283`
- `Object id masking` = Server parses incoming 4-byte fields through v0_val_type { int data:28; unsigned int tag:4 }, so ids are truncated to the low 28 bits and the top nibble is consumed as the tag. Client-side: GetObjId(id) = id & 0x0fffffff, GetObjTag(id) = (id & 0xf0000000) >> 28. — `blakserv/parsecli.c:105 (`v0_val_type in_val;  // Client sends 32-bit values`); include/bkod.h:211-216; clientd3d/object.h:22-24`
- `SIZE constants for the buy/withdrawal lists` = SIZE_ID = 4, SIZE_LIST_LEN = 2, SIZE_AMOUNT = 4, SIZE_COST = 4, SIZE_VALUE = 4 — `include/proto.h:507-522`
- `MOB_BUYER NPCs and their sell-to-you multiplier (best first)` = 90 % (MERCHANT_BARGAIN): Hazar apothecary (hzapoth, reagents+gems), Hazar smith (hzsmith), Jasper smith (jssmith). 80 % (MERCHANT_DISCOUNT): Barloque apothecary (bqapoth), Barloque merchant (bqmerch, gems+sundry, refuses stacks > 25), Tos apothecary (TsApoth), wanderer Izzio (buys almost anything). 70 % (MERCHANT_NORMAL, the default): Maren smith (MrSmith), &Thief (no ObjectDesired override, so buys anything), guild-hall creator, Maren innkeeper. 60 % (MERCHANT_EXPENSIVE): Corinth grocer, Kocatan apothecary/bartender/shopkeeper/smith/tailor, Barloque smith, Tos smith. 50 % (MERCHANT_RIPOFF): Barloque assassin, Jasper merchant, Kocatan trade master (kcmerch — but its ObjectDesired is a bare `return TRUE`, so it buys literally anything). — `markups: kod/.../barlqtwn/bqSmith.kod:41, bqapoth.kod:39, bqmerch.kod:34, assassin.kod:101, crnthtwn/cngrocer.kod:38, hazartwn/hzapoth.kod:34, hzsmith.kod:33, jasprtwn/jsmerch.kod:36, jssmith.kod:36, kocatwn/kcapoth.kod:38, kcbart.kod:33, kcmerch.kod:43, kcshopk.kod:46, kcsmith.kod:36, kctailor.kod:59, marntwn/MrSmith.kod:36, tostwn/TsApoth.kod:37, TsSmith.kod, wanderer/izzio.kod:54; default monster.kod:207; kcmerch ObjectDesired at kcmerch.kod:52-56; thief.kod:38 MOB_BUYER with no ObjectDesired override`
- `Alternative instant-sell path: Tos banker 'Skivlat' buys gems` = MOB_RECEIVE (not MOB_BUYER). Offer him Ruby/Emerald/Sapphire/Diamond in a stack of >= 4 via BP_REQ_OFFER or BP_REQ_DEPOSIT and CheckWhyWanted pays GetValue * (100 - 10*MERCHANT_BARGAIN)/100 = 90 % IMMEDIATELY, with no counteroffer and no accept step — but Random(0,19)=0 (5 %) declares the gems fake and destroys them for nothing. — `kod/.../monster/towns/tostwn/TsBanker.kod:40-45 (attributes, MERCHANT_BARGAIN), 81 (plWantedItems = [&Money,&Ruby,&Emerald,&Diamond,&Sapphire]), 100-165 CheckWhyWanted (the 5 % loss at 116-120, the 90 % pay at 145-148)`
- `PawnMan (dead code)` = kod/object/active/holder/nomoveon/pawnman.kod pays 100 % of GetValue with no markup, but it is never instantiated anywhere in the kod tree and it is a NoMoveOn, not a Monster, so it has no CanAcceptOffer handler. — `kod/object/active/holder/nomoveon/pawnman.kod:42-100; grep for PawnMan across kod/ returns only its own file; kod/object.kod:702-707 default CanAcceptOffer returns FALSE`

### What two agents can exploit or must respect

- PRICE ORACLE (the answer to 'how do I learn value before selling'): BP_REQ_OFFER(120) -> read the amount field of the single &Money object inside BP_COUNTEROFFER(214) -> BP_CANCEL_OFFER(122). Nothing is transferred until BP_ACCEPT_OFFER(121), so this is a free, repeatable, non-destructive query. The number you get back is `Bound(GetValue(item)*(100-10*markup)/100, 1, $)` summed over the offer, so probing one item at a time yields per-item value; divide by the merchant's known multiplier (see the markup table) to recover GetValue exactly. Budget: you must cancel within 30 s and only one probe at a time per merchant (poCustomer is a single slot).
- OFFLINE ORACLE, no server needed: viValue_average is a compile-time classvar on every item class in kod/object/item/**. An agent that wants to split loot fairly without touching a merchant should ship a static class-name -> viValue_average table harvested from the source, then apply GetValue's condition curve: value = Bound(viValue_average * (100*piHits_init*piHits)/(viHits_init_max^2) / 100, 10, viValue_average). Condition is partially observable from the look description prose (immaculate > 90 %, scuffed > 65 %, unsightly rips > 30 %, in tatters <= 30 %, ripped beyond use = 0 hits) at kod/object/item.kod:155-193, and viHits_init_max is also a compile-time classvar.
- ONLY ONE AGENT CAN BE IN AN OFFER WITH A GIVEN MERCHANT AT A TIME. Monster.poCustomer is a single slot; a second agent gets Lm_buyer_offer_busy ("%s is busy right now with another customer."). Each agent's own poOffer_who is also a single slot, so an agent cannot probe two merchants concurrently. A cancelled or timed-out offer frees the slot; a stalled agent holds it for up to 30 s. Cooperating agents should serialise merchant access; a competing agent can deny a merchant by camping the slot with 30 s probes.
- ALL-OR-NOTHING OFFERS. If any single item in the list fails CanBeGivenToNPC, ReqLeaveHold, ObjectDesired or the quest-node check, the ENTIRE offer is refused and you get only a BP_MESSAGE. Offer one item per request when probing, and batch only after each item is known-acceptable.
- SILENT FAILURE MODE TO GUARD AGAINST: when ReqOffer returns FALSE, UserOffer calls CleanupCancelOffer and returns WITHOUT sending BP_OFFERED or BP_OFFER_CANCELED (user.kod:4986-4991). So a refused sale produces no offer-protocol packet at all — only a BP_MESSAGE(32). Any state machine that waits for BP_OFFERED or BP_OFFER_CANCELED after BP_REQ_OFFER will hang. Use a client-side timeout and treat 'no offer packet within a round trip' as refusal.
- BP_OFFER_CANCELED IS AMBIGUOUS. It is sent both on genuine cancellation AND at the successful end of a passive AcceptOffer purely to dismiss the dialog (user.kod:5648-5651). Do not use it as a failure signal; confirm the sale by checking whether the money arrived.
- 4-BYTE TOP-NIBBLE TRAP, applies to EVERY {4,TAG_OBJECT} and {4,TAG_INT} field, not just list elements: parsecli.c:361-388 reads the field through v0_val_type and, if the top nibble is CLIENT_TAG_NUMBER (1), consumes 4 MORE bytes as number_stuff. This means (a) always write merchant/vaultman ids with top nibble 0, and (b) never send a UC_DEPOSIT / UC_WITHDRAW amount >= 0x10000000. kod ints are 28-bit anyway (MAX_KOD_INT = 0x07ffffff).
- OBJECT LIST ORDER IS REVERSED BY THE SERVER (parsecli.c:279-281). Amounts are reversed in the same pass, so #item_list and #number_list stay aligned even for mixed lists of plain items and NumberItem stacks. But if you ever need to correlate a server reply to a specific request slot, remember the server saw your list backwards.
- BP_BUY_LIST(216) HAS ITS LENGTH CHECK DISABLED CLIENT-SIDE (`if (0)` at clientd3d/server.c:1180-1186), so a wrong byte count desyncs silently. BP_WITHDRAWAL_LIST(231) DOES check (`if (len != 0) return false`, server.c:1218-1223) and fails loudly. Use BP_REQ_WITHDRAWAL(232) rather than BP_REQ_BUY(124) against a vaultman if you want your parser validated — they return the same information.
- DO NOT SEND BP_REQ_WITHDRAWAL(232) TO A NON-VAULTMAN SELLER. UserWithdrawal only builds a packet when MobIsVaultman but calls SendPacket unconditionally (user.kod:5740-5750), reaching SendPacket with a NULL buffer list.
- BP_REQ_DEPOSIT(230) IS A SINGLE ROUND TRIP with no accept and no BP_OFFERED — the deposit is already done by the time ReqOffer returns FALSE. Do not send BP_ACCEPT_OFFER after it; do not wait for a counteroffer. Same for cash to a banker (one &Money item), though UC_DEPOSIT(155/35) is simpler.
- UC_DEPOSIT/UC_WITHDRAW/UC_BALANCE go to the FIRST object in the room that answers TRUE, and a MOB_VAULTMAN answers TRUE for DEPOSIT and WITHDRAW while doing nothing (monster.kod:5112-5129). If a room contains both a vaultman and a banker, your cash command may be swallowed with no reply. Prefer BP_REQ_DEPOSIT(230) with an explicit target object id when both are present.
- THE BALANCE REPLY IS A CHAT LINE, NOT A PACKET TYPE. Parse BP_MESSAGE(32) where the 4-byte message resource id equals monster_say_to_one and the 4-byte parm3 equals Lm_bnkr_balance; the balance is parm4 at body offset 17..20. MsgSendUser omits NIL parameters, so parameter positions are message-dependent — switch on parm3. Also note BankBalance uses Post (arrives a tick later) while BankDeposit/BankWithdraw use Send (immediate).
- MOOD IS NOT WORTH OPTIMISING FOR MONEY. It never touches a price or a willingness-to-buy check. Its only levers are: buying an item from the merchant (MOODMOD_SELL_ITEM, typically +2), giving it a wanted item (MOODMOD_ACCEPT_ITEM), banking/vaulting, dawn/dusk swings, and saying LIBACT_MOOD keywords aloud in the room (BP_SAY_TO = 110). Selling loot TO a merchant moves mood zero. If an agent does want good mood — the only real payoff is unlocking mood-gated library speech, which can trigger LIBACT_CONDITIONAL to add a fixed-price item to the merchant's conditional list — the cheapest route is repeating a positive keyword; the spam list that blocks repeats is cleared on every RandomTimer tick.
- MERCHANTS ARE AN INFINITE MONEY SINK AND AN INFINITE ITEM SOURCE. Payment is Create(&Money,...) from nothing, and non-vbSellFromInventory sellers hand out Create(#model=i) copies forever. There is no market depth to exhaust and no reason to spread sales across merchants for liquidity — only for markup. The two exceptions are the Kocatan Shopkeeper and Izzio, whose 25-slot stock is real and restocks on a 12-24 h timer, and whose ObjectDesired refuses a class they already stock (so two agents dumping identical loot on them will have the second one refused).
- BEST SELL VENUES, in order: Hazar apothecary / Hazar smith / Jasper smith at 90 % (but narrow ObjectDesired — reagents+gems, and smith categories); then Izzio, Barloque merchant, Barloque and Tos apothecaries at 80 %; then any bare MOB_BUYER at the 70 % default. Two merchants have a `return TRUE` ObjectDesired and will buy literally anything: Kocatan trade master (kcmerch, 50 %) and &Thief (70 %). Tos banker Skivlat is the outlier — 90 % on gem stacks of 4+, paid instantly with no accept step, at a 5 % risk of total loss.
- CROSS-MERCHANT ARBITRAGE IS BLOCKED BY CONSTRUCTION. Sell price uses GetValue and buy price uses GetInitValue with a strictly larger multiplier for every markup except MERCHANT_FLAT (0), and no MOB_BUYER in the tree has MERCHANT_FLAT. Best case is buy at 120 % from a BARGAIN seller and sell at 90 % to a BARGAIN buyer — always a loss. Do not build a loop around it. (The TsBanker source comment at line 146 says exactly this: 'Skivlat needs to include markup to prevent scams where he buys more than he sells.')
- A MOB_LAWFUL merchant refuses a PFLAG_MURDERER only when more than one non-DM Player is in the room. A murderer agent can still trade by clearing the room of other players — the NPC grumbles (monster_illicit_service) and serves anyway (monster.kod:5085-5093).
- Vault economics for shared storage: 3000 bulk per player per vault, deposit costs 1 gp/stone (2 in Kocatan), retrieval free (1/item in Kocatan). Zero-bulk items (gold) cannot be vaulted. Bank and vault ids are per-town, and Storage.GetBankNum returns the same piVault_num as GetVaultNum — accounts are not shared across towns.

### Not determined

- Whether the merchant Offer/AcceptOffer handoff via SYS GetSystemHolder1/GetSystemHolder2 can be raced. Both Monster.AcceptOffer (monster.kod:3181-3208) and User.UserAcceptOffer (user.kod:5507-5588) drain the two global system holders unconditionally by iterating GetHolderActive/GetHolderPassive, with no per-transaction tagging. If two offers complete in the same tick, the wrong party could receive the other's goods. I did not trace whether the kod scheduler guarantees atomicity across a Send chain (SendBlakodMessage in blakserv/sendmsg.c is synchronous, so a single Send chain is probably atomic, but Post-deferred paths inside these handlers were not audited). Looked at: monster.kod:3181-3208, user.kod:5507-5588, kod/util/system.kod for GetSystemHolder1/2.
- Exact behaviour of SendPacket(session) when blist == NULL, which is reachable via BP_REQ_WITHDRAWAL(232) aimed at a non-vaultman seller with a non-empty for-sale list. blakserv/commcli.c:181-195 passes NULL straight into SecurePacketBufferList/SendClientBufferList; I did not read those two functions. Treat as 'do not do this'.
- Whether an NPC merchant's plFor_sale can ever be re-created after Constructor. SetForSale is called once from Monster.Constructor when MobIsSeller (monster.kod:355-358), and the base SetForSale just nils the list (monster.kod:4789-4794). Only kcshopk/izzio have restock timers. I did not find any global respawn/reset that would re-run Constructor on town NPCs, so I cannot state whether a town merchant's stock is ever refreshed across a server lifetime. Looked at: monster.kod:355-358, 4392-4426 DeleteForSaleList, 490-503, kod/util/system.kod:6662 (a one-off `Send(&BarloqueApothecary, @SetForSale)`).
- The full list of ITEMTYPE_SPECIAL / IA_BONDED classes that ObjectDesired rejects on the two inventory-selling shopkeepers. I confirmed the checks exist (kcshopk.kod:248-258, izzio.kod:283-291) but did not enumerate every class that satisfies them.
- Whether saying a LIBACT_MOOD keyword requires the NPC to be MOB_LISTEN and within the say range, and what the exact BP_SAY_TO(110) payload is. Speech is a different subsystem; I only established that BP_SAY_TO = 110, SAY_NORMAL = 1 and that the library keyword tables at kod/util/library.kod:1316-1400 are the mood levers. The say-range gating (MOB_FULL_TALK = 0x08000) was not traced.
- Whether BP_REQ_DEPOSIT to a banker with a Money stack double-deletes the temporary NumberItem copy. GotWantedItem does `Send(obj,@Delete)` (monster.kod:2492) and then User.CleanupCancelOffer also Deletes NumberItem entries in plOffer_items (user.kod:5227-5243). It looks like a harmless double delete but I did not check Object.Delete for idempotence. Use UC_DEPOSIT(155/35) for cash to avoid the question entirely.
- Whether the `bAllWanted` local in Monster.ReqGive is an intentional design or a bug. It is initialised TRUE at monster.kod:2378 but unconditionally set FALSE for every item at 2402 and never restored, so ReqGive can only return TRUE via the quest-node early return (2394-2399) or the vaultman branch (2436-2440). This is what makes BP_REQ_DEPOSIT a one-shot; if it is ever fixed, the deposit flow gains an accept step and any agent depending on the one-shot behaviour breaks.


---

## Navigation between rooms (room graph, exits, room identity/geometry, fast travel)

Room-to-room travel has exactly two walking mechanisms, both driven entirely by server-side kod data that is invisible to the protocol. (1) Walking off the grid: Room.SomethingMoved bounds-checks new_row/new_col against piRows/piCols and, on violation, calls StandardLeaveDir with a LEAVE_* direction (room.kod:2232-2258, 2645); StandardLeaveDir scans plEdge_Exits for a matching direction and hands the destination ROOM NUMBER to SYS FindRoomByNum. (2) Standing on an exit square and sending BP_REQ_GO(102, zero payload): UserGo forwards the server's cached piRow/piCol to poOwner @SomethingTryGo (user.kod:5654-5687), whose base implementation scans plExits for a [row,col] match. Both lists store piRoom_num RIDs, never object ids, so they are save-stable; FindRoomByNum is a hash lookup RID->room object (system.kod:1238-1241, table built at system.kod:753-757). NOTHING in the protocol identifies an exit — there is no Door class anywhere in the tree, exits are pure kod tables, and the only exit-ish thing on the wire is the OF_MOVEON_TELEPORTER (2) value in the low 2 bits of an object's 4-byte flags field, which marks Portal objects that teleport you when you step on their square. Room dimensions are NOT sent over the protocol: BP_PLAYER(130) carries only room_res, the resource id of the .roo filename, so an agent must resolve that id through kodbase.txt + the client .rsc files and read rows/cols out of the .roo server section itself. The .roo server section additionally contains the per-square walkability grid the agent needs for intra-room pathfinding, even though the server never validates player movement against it.

### Wire formats

**BP_REQ_MOVE (100) — client->server**

```
opcode(1)=100 | row(2, LE unsigned) | col(2, LE unsigned) | speed(1) | roomObjectId(4)

row and col are in KOD fineness with a +1-square bias: wire_row = row*64 + fine_row + 64, wire_col = col*64 + fine_col + 64. Server decodes new_row = wire_row/64, fine_row = wire_row mod 64 (user.kod:2937-2938 via ReceiveClientMessage at user.kod:902-919). Row FIRST, col SECOND — confirmed on both ends.
```

*blakserv/sprocket.c:24-25 (table: {2,TAG_INT}{2,TAG_INT}{1,TAG_INT}{4,TAG_OBJECT}); clientd3d/protocol.h:73-76 (RequestMove macro, comment "Convert from client 0-based coordinates to server 1-based coordinates"); kod/object/active/holder/nomoveon/battler/player/user.kod:900-920*

roomObjectId MUST equal the player's current owner room object id or the packet is silently discarded with no reply (user.kod:909-913: "if oRoom <> poOwner { return; }"). speed > USER_WALKING_SPEED(18) with vigor < VIGOR_RUN_THRESHOLD gets you snapped back to your old square (user.kod:2958-2971). Every BP_REQ_MOVE increments an anti-speedhack counter decremented one per second; > MOVEMENT_COUNT_THRESHOLD only logs, does not block (user.kod:2941-2956). There is NO geometry validation: UserMove calls Room.SomethingMoved directly, and ReqSomethingMoved is bypassed for users (util.kod:112-113 "if IsClass(what,&User) OR Send(where,@ReqSomethingMoved...)"; room.kod:2046 doc string "server_validate is set to false for user moves, which have already been checked by client (HAHA!)").

**BP_REQ_GO (102) — client->server**

```
opcode(1)=102 — that is the ENTIRE message. Zero parameters.
```

*blakserv/sprocket.c:53 ({ BP_REQ_GO, { {0, DONE_PARM} } }); clientd3d/protocol.c:55; clientd3d/protocol.h:95; kod/object/active/holder/nomoveon/battler/player/user.kod:1164-1177*

The server uses ITS OWN cached piRow/piCol/piFine_row/piFine_col for the lookup, not anything in the packet (user.kod:5669-5670). The real client therefore always calls MoveUpdatePosition() (a BP_REQ_MOVE) immediately before RequestGo() (clientd3d/intrface.c:392-394); an agent must do the same or it will 'go' from a stale square. Failure produces a BP_MESSAGE with user_cant_go plus a wav, not a silent drop (user.kod:5672-5686). A missing/unset SomethingTryGo returns $ and logs a Debug line server-side.

**BP_REQ_TURN (101) — client->server**

```
opcode(1)=101 | objectId(4) | angle(2, LE, 0..4095)
```

*blakserv/sprocket.c:35; kod/object/active/holder/nomoveon/battler/player/user.kod:922-930*

MAX_ANGLE = 4096, ANGLE_EAST=0 and angles increase clockwise through SOUTH=1024, WEST=2048, NORTH=3072 (blakston.khd:1229-1242). Needed only because plExits/plEdge_Exits rotate your facing on arrival; irrelevant to which room you land in.

**BP_PLAYER (130) — server->client**

```
opcode(1)=130 | playerObjId(4) | iconRsc(4) | nameRsc(4) | roomObjId(4) | roomRsc(4) | roomNameRsc(4) | roomSecurity(4) | ambientLight(1) | playerLight(1) | backgroundRsc(4, 0 if none) | wadingSoundRsc(4) | roomClientFlags(4) | overrideDepth1(4) | overrideDepth2(4) | overrideDepth3(4)

The last five 4-byte fields are appended by Room.SendExtraRoomInfo and are ALWAYS present (five unconditional AddPacket(4,...) calls).
```

*kod/object/active/holder/nomoveon/battler/player/user.kod:2467-2489 (send side); clientd3d/server.c:601-641 (HandlePlayer parse); kod/object/active/holder/room.kod:1924-1932 (SendExtraRoomInfo)*

THIS IS THE ONLY ROOM-IDENTITY MESSAGE AND IT CARRIES NO ROWS/COLS. roomRsc is the resource id of the .roo FILENAME; the client resolves it with LookupRsc and loads the file itself (clientd3d/game.c:276-289). roomSecurity is a checksum the client compares against the .roo's own security dword (clientd3d/game.c:296-304). roomObjId is a kod object id, not a RID. Subclasses may override SendExtraRoomInfo, but no override in the tree changes the field count (all rooms inherit room.kod's).

**BP_ROOM_CONTENTS (134) — server->client**

```
opcode(1)=134 | roomObjId(4) | count(2) | count x roomItem

roomItem = object | row(2) | col(2) | angle(2) | movePaletteTranslation | moveAnimation | moveOverlays

where "object" is the standard structure (id(4) [amount(4) if top nibble==1] iconRsc(4) nameRsc(4) flags(4) rarity(4) dLighting paletteTranslation animation overlays) and row/col are wire = square*64 + fine (Nth(i,3)*FINENESS+Nth(i,5)).
```

*kod/object/active/holder/nomoveon/battler/player/user.kod:2545-2600 (ToCliRoomContents); clientd3d/server.c:643-680 (HandleRoomContents), 384-405 (ExtractNewRoomObject), 319-352 (ExtractObject)*

DESYNC HAZARD: each roomItem contains TWO palette/animation/overlay blocks — one inside "object" (from ToCliObject's SHOW_NORMAL branch, user.kod:2457-2461) and a SECOND set AFTER the angle (from SendMoveAnimation/SendMoveOverlays, user.kod:2586-2587). ExtractNewRoomObject reads them in exactly that order. Default bodies emit ANIMATE_NONE(0)+group(2) = 3 bytes for an animation and a single 0 byte for overlays (object.kod:445-452, 462-478); ExtractAnimation consumes 1+2 for ANIMATE_NONE, 1+4+2+2 for ANIMATE_CYCLE(1), 1+4+2+2+2 for ANIMATE_ONCE(2) (clientd3d/server.c:222-261). The count is computed as len(passive)+len(active minus stealthed DMs) BEFORE the loops, so counts and items always agree. The list is flat: active (players/monsters/portals) come first, then passive, with no marker between them. No exit information appears anywhere in this message.

**BP_MOVE (200) — server->client**

```
opcode(1)=200 | objectId(4) | row(2) | col(2) | speed(1, high bit 0x80 = turn-to-face)
```

*clientd3d/server.c:682-712 (HandleMove); clientd3d/server.c:176-184 (ExtractCoordinates: first word is y/row, second is x/col, both minus KOD_FINENESS)*

Confirms the row-then-col ordering and the +64 bias used in the opposite direction. Useful as the signal that the server accepted a move, but note that a successful ROOM CHANGE is announced by a fresh BP_PLAYER + BP_ROOM_CONTENTS, not by BP_MOVE.

**BP_USERCOMMAND / UC_REQ_RESCUE (155) — client->server**

```
opcode(1)=155 | subopcode(1)=41 (UC_REQ_RESCUE) — no further payload.
```

*kod/include/protocol.khd:108 (BP_USERCOMMAND=155), :206 (UC_REQ_RESCUE=41); blakserv/sprocket.c:129 ({ UC_REQ_RESCUE, { {0, DONE_PARM} } }); kod/object/active/holder/nomoveon/battler/player/user.kod:1930-1946*

REAL PLAYER-ACCESSIBLE FAST TRAVEL. Calls AdminGoToSafety, which teleports you to your homeroom's viTeleport_row/viTeleport_col and rewrites piSave_room (user.kod:7076-7107). Guard: if you are ALREADY in your homeroom the server instead replies BP_USERCOMMAND(1,UC_SEND_QUIT=1) and does nothing. No cooldown, no cost, no level check in this path. BP_USERCOMMAND is dispatched through USERCOMMAND_TABLE_PARM redirection in blakserv/parsecli.c:139-149.

**BP_REQ_CAST (105) — client->server**

```
opcode(1)=105 | spellObjectId(4) | targetCount(2) | targetCount x objectId(4)
```

*blakserv/sprocket.c:63 ({ BP_REQ_CAST, { {4, TAG_OBJECT}, {2, LIST_OBJ_PARM} } }); kod/include/protocol.khd:59*

The spell object ids are learned from BP_SPELLS(141)/BP_SPELL_ADD(142), which are parsed in module/merintr/merintr.c, not clientd3d/server.c. Navigation-relevant spell numbers: SID_ELUSION=169, SID_RESCUE=7, SID_BLINK=32, SID_PORTAL_OF_LIFE=110 (blakston.khd:1994, 1843, 1866, 1935).

**BP_SAY_TO (110) — client->server**

```
opcode(1)=110 | sayType(1) | strLen(2) | strLen bytes (no NUL)
```

*blakserv/sprocket.c:27 ({ BP_SAY_TO, { {1, TAG_INT}, {0,TAG_TEMP_STRING} } }); kod/object/active/holder/nomoveon/battler/player/user.kod:1024-1031; include/proto.h:276 (SAY_NORMAL=1)*

This is the second half of the Elusion fast-travel mechanism: while in the Elusion casting trance the spoken string is matched against candidate room names with StringContain, and a match posts @Teleport to that room (elusion.kod:139-186).

**BP_SET_VIEW (237) — server->client**

```
opcode(1)=237 | objectId(4) | viewFlags(4) | viewHeight(4) | viewLight(1)
```

*clientd3d/server.c:108, 1894-1912 (HandleSetView); include/proto.h:215*

Checked as requested: contains NO room geometry. It only re-parents the camera to another object (remote viewing). BP_RESET_VIEW=238 undoes it. Neither carries rows/cols.

### Rules, in the order the server checks them

| | rule | where |
|---|---|---|
| **silent** | plEdge_Exits element 1 must equal the LEAVE_* direction derived from WHICH bound was violated: new_row > piRows -> LEAVE_SOUTH(1); new_row < 1 -> LEAVE_NORTH(2); new_col > piCols -> LEAVE_EAST(4); new_col < 1 -> LEAVE_WEST(3). If no entry matches that direction, iRoom stays 0 and the function returns with the player having moved NOWHERE. | `kod/object/active/holder/room.kod:2232-2258, 2653-2655, 2719, 2745-2751` |
| **silent** | For a plEdge_Exits entry of Length 5 the destination is taken unconditionally and the loop breaks. For Length 6 or 7 the entry only fires if Nth(i,6) matches one of ROW_IS_GREATER_THAN/ROW_IS_LESS_THAN/COL_IS_GREATER_THAN/COL_IS_LESS_THAN and the mover's CURRENT cached row/col satisfies the comparison against Nth(i,7); NO_OTHER_CONDITIONS(5) records the destination as a fallback but does NOT break, so a later-iterated conditional entry can still win. | `kod/object/active/holder/room.kod:2657-2717` |
| **silent** | The conditional comparison uses Send(what,@GetRow)/@GetCol — the mover's LAST IN-ROOM square, not the off-grid coordinate that triggered the exit. Room.SomethingMoved returns at the bounds check (room.kod:2232-2258) before it reaches the SetNth position update and the per-occupant @SomethingMoved notification loop, so the cached piRow/piCol are still the previous square. | `kod/object/active/holder/room.kod:2232-2258 vs 2262-2274 and 2320-2331; kod/object/active/holder/nomoveon.kod:45-53 (GetRow returns piRow); kod/object/active/poscache.kod:52-64 (piRow updated only in SomethingMoved)` |
| **silent** | Monsters are refused all edge-exit room changes outright: StandardLeaveDir returns immediately if IsClass(what,&Monster). | `kod/object/active/holder/room.kod:2722-2729` |
| message | Users crossing into a room via plEdge_Exits or plExits must pass Player.UserReqNewOwner(RID). Its only refusal is: destination IsClass(&GuildHall) and the player does not have PFLAG_PKILL_ENABLE. | `kod/object/active/holder/nomoveon/battler/player.kod:11735-11760; called from kod/object/active/holder/room.kod:2731-2734 and 2795-2799` |
| message | Base Room.SomethingTryGo requires an EXACT square match: row = First(i) AND col = Nth(i,2) against plExits. Fine coordinates are ignored by the base implementation (though some room overrides do test fine_row/fine_col, e.g. kocinn.kod:85-112). | `kod/object/active/holder/room.kod:2771-2779` |
| message | A plExits entry whose Nth(i,3) = ROOM_LOCKED_DOOR (-1) is a dead end: it consumes the 'go' and prints a message. If Length(i) = 4 the message is Nth(i,4), else room_door_is_locked. It returns TRUE, so UserGo reports success and no further plExits entries are tried. | `kod/object/active/holder/room.kod:2779-2791; kod/include/blakston.khd:371 (ROOM_LOCKED_DOOR = -1)` |
| **silent** | Room subclasses may override SomethingTryGo and either (a) return TRUE after only animating a sector-lift door (no room change), or (b) hardcode a UtilGoNearSquare to another RID that is in NEITHER plExits nor plEdge_Exits. 44+ room classes do this. A static graph built only from the two lists will be incomplete. | `kod/object/active/holder/room/ghall.kod:981-1007 (guild outer doors, plGuild_doors, opens sector only); kod/object/active/holder/room/monsroom/f8.kod:106-135 (hardcoded UtilGoNearSquare to RID_GUILDH3); kod/object/active/holder/room/guildh1.kod:104-116` |
| **silent** | Portal objects (viObject_flags = MOVEON_TELEPORTER) teleport you on Room.SomethingMoved when your new square equals theirs — you never send BP_REQ_GO. Portal.SomethingMoved no-ops if pbAnimate is FALSE (a 'dead' portal) or if what = self. | `kod/object/active/portal.kod:29 (viObject_flags = MOVEON_TELEPORTER), 94-116 (SomethingMoved), 118-140 (TeleportSomething)` |
| **silent** | UtilGoNearSquare is the arrival primitive for every room change. It spiral-searches outward from the target square, clamped to 1..GetRoomRows / 1..GetRoomCols, up to max_distance (default 50000). Neither StandardLeaveDir nor Room.SomethingTryGo passes max_distance, so arrival is best-effort anywhere in the room and effectively cannot fail. | `kod/util.kod:20-104; called without max_distance at kod/object/active/holder/room.kod:2739-2741 and 2824-2826` |
| **silent** | The 7th element of a plExits entry (DISTANCE_NORMAL = 3) is DEAD DATA. Room.SomethingTryGo never reads Nth(i,7) and never passes max_distance to UtilGoNearSquare. 12 plExits entries in the tree carry it. | `kod/object/active/holder/room.kod:2824-2826 (no #max_distance); property comment at room.kod:217-219 promises it; kod/include/blakston.khd:1210 (DISTANCE_NORMAL = 3)` |
| **silent** | The region restriction ("mortals cannot be teleported between different regions") applies ONLY to AdminGoToObject, not to any walking exit. Room.GetRegion buckets by RID range: RID_GUEST_BASE, RID_NEWB_BASE, RID_KOCATAN, RID_ORC_CAVE1, RID_BRAX, else RID_DEFAULT. | `kod/object/active/holder/nomoveon/battler/player/user.kod:7264-7270; kod/object/active/holder/room.kod:900-945` |
| message | PFLAG_NO_MOVE or an active &Blind enchantment blocks BP_REQ_GO entirely, before SomethingTryGo is consulted. | `kod/object/active/holder/nomoveon/battler/player/user.kod:5658-5666` |
| **silent** | Incoming packet throttling: more than INCOMING_PACKET_THROTTLE packets in one second sets bSpam, which suppresses BP_REQ_GO (returns before UserGo) for non-immortals. BP_REQ_MOVE is NOT suppressed. | `kod/object/active/holder/nomoveon/battler/player/user.kod:874-888, 1164-1177` |
| message | Elusion (SID_ELUSION=169) may only be cast from RID_TOS, RID_MARION, RID_BARLOQUE, RID_CORNOTH, RID_JASPER, RID_KOC_INN, or your own guild hall. Destination count = bound(spellpower/16, 1, 6) randomly drawn from the five town centres; 96+ spellpower adds Kocatan, and 5+ destinations adds your guild hall. | `kod/object/passive/spell/elusion.kod:85-110 (cast location check), 187-215 (GetLocations)` |

### Constants

- `LEAVE_SOUTH` = 1 — `kod/include/blakston.khd:1219`
- `ENTER_NORTH` = 1 (same number as LEAVE_SOUTH; used only by ReqSomethingMoved's neighbour-square derivation, never in plEdge_Exits) — `kod/include/blakston.khd:1220; kod/object/active/holder/room.kod:2068-2091`
- `LEAVE_NORTH` = 2 — `kod/include/blakston.khd:1221`
- `ENTER_SOUTH` = 2 — `kod/include/blakston.khd:1222`
- `LEAVE_WEST` = 3 — `kod/include/blakston.khd:1223`
- `ENTER_EAST` = 3 — `kod/include/blakston.khd:1224`
- `LEAVE_EAST` = 4 — `kod/include/blakston.khd:1225`
- `ENTER_WEST` = 4 — `kod/include/blakston.khd:1226`
- `ROW_IS_GREATER_THAN` = 1 — `kod/include/blakston.khd:1212`
- `ROW_IS_LESS_THAN` = 2 — `kod/include/blakston.khd:1213`
- `COL_IS_GREATER_THAN` = 3 — `kod/include/blakston.khd:1214`
- `COL_IS_LESS_THAN` = 4 — `kod/include/blakston.khd:1215`
- `NO_OTHER_CONDITIONS` = 5 — `kod/include/blakston.khd:1216`
- `ROOM_LOCKED_DOOR` = -1 (sentinel in plExits slot 3) — `kod/include/blakston.khd:371`
- `DISTANCE_NORMAL` = 3 (plExits slot 7; never read) — `kod/include/blakston.khd:1210`
- `ROTATE_NONE .. ROTATE_315` = ROTATE_NONE=8, ROTATE_45=9, ROTATE_90=10, ROTATE_135=11, ROTATE_180=12, ROTATE_225=13, ROTATE_270=14, ROTATE_315=15 — values >= 8 are RELATIVE rotations of (v-8) eighths — `kod/include/blakston.khd:1253-1260; kod/object/active/holder/room.kod:2754-2764`
- `SET_ANGLE_EAST .. SET_ANGLE_SOUTH_EAST` = 0..7 — values < ROTATE_NONE are ABSOLUTE: iAngle = v * (MAX_ANGLE/8) — `kod/include/blakston.khd:1263-1271; kod/object/active/holder/room.kod:2760-2763`
- `MAX_ANGLE` = 4096 (ANGLE_EAST=0, ANGLE_SOUTH=1024, ANGLE_WEST=2048, ANGLE_NORTH=3072) — `kod/include/blakston.khd:1229, 1231-1238`
- `FINENESS (kod)` = 64, FINENESS_HALF = 32 — `kod/include/blakston.khd:1163-1164`
- `KOD_FINENESS / FINENESS (client)` = KOD_FINENESS=64 (LOG=6); client FINENESS=1024 (LOG_FINENESS=10) — `clientd3d/drawdefs.h:42-43, 52-53`
- `MOVEON_TELEPORTER / OF_MOVEON_TELEPORTER` = 2; mask OF_NOMOVEON_MASK = 0x00000003 over the object's 4-byte flags field. MOVEON_YES=0, MOVEON_NO=1, MOVEON_NOTIFY=3. — `kod/include/blakston.khd:54-57; include/proto.h:357, 415-418`
- `ROOM_FLAG_WALKABLE` = 0x01, tested against .roo server-section flags[to_row][to_col] — `blakserv/roomdata.h:38-41; blakserv/roomdata.c:151-158`
- `.roo move-grid direction masks` = MASK_NORTH=1, MASK_NORTH_EAST=2, MASK_EAST=4, MASK_SOUTH_EAST=8, MASK_SOUTH=16, MASK_SOUTH_WEST=32, MASK_WEST=64, MASK_NORTH_WEST=128 — 'north' means to_row-from_row = -1, so row increases southward and col increases eastward — `blakserv/roomdata.c:28-38, 198-228`
- `.roo magic` = 0x52 0x4F 0x4F 0xB1 ("ROO\xB1"); minimum ROO_VERSION enforced by both server and client — `blakserv/roofile.c:20; clientd3d/bspload.c:27`
- `Special RID ranges` = RID_DEFAULT=1, RID_UNDERWORLD=1, RID_OOG/RID_OUTOFGRACE=43, RID_TOS=50, RID_BARLOQUE=102, RID_CORNOTH=150, RID_MARION=200, RID_BRAX_END=833, RID_GUEST_BASE=1000, RID_GUEST1=1001, RID_NEWB_BASE=1010, RID_NEWB_MAX=1018, RID_KOCATAN_END=2499, RID_ORC_CAVE_END=2599, RID_OLD_JASPER=9000, RID_RENTABLE_START=10000 — `kod/include/blakston.khd:373-866 (RID block); specifically 373, 375, 400-401, 409, 435, 454, 464, 704, 736-737, 752, 767, 831, 849, 860, 866`
- `Navigation spell ids` = SID_RESCUE=7, SID_BLINK=32, SID_PORTAL_OF_LIFE=110, SID_ELUSION=169 — `kod/include/blakston.khd:1843, 1866, 1935, 1994`
- `Exit-table population volume` = 162 kod files contain 'plExits = Cons' (1052 entries: 148 x 3-element locked doors, 203 x 4-element locked doors with message, 689 x 6-element normal, 12 x 7-element); 112 kod files contain 'plEdge_Exits = Cons' (281 entries: 192 x 5, 7 x 6, 82 x 7) — `derived by grep/awk over kod/**/*.kod; see kod/object/active/holder/room/jasperrm/jasper.kod:53-85 for a representative file`

### What two agents can exploit or must respect

- plEdge_Exits POSITION-BY-POSITION. Every entry is a flat list; positions are: [1] direction = LEAVE_SOUTH(1)/LEAVE_NORTH(2)/LEAVE_WEST(3)/LEAVE_EAST(4); [2] destination piRoom_num (a RID integer, NOT an object id); [3] destination row (1-based); [4] destination col (1-based); [5] angle modifier (ROTATE_* relative, or SET_ANGLE_* absolute); [6] (6- and 7-element forms only) condition selector ROW_IS_GREATER_THAN(1)/ROW_IS_LESS_THAN(2)/COL_IS_GREATER_THAN(3)/COL_IS_LESS_THAN(4)/NO_OTHER_CONDITIONS(5); [7] (7-element form only) the integer threshold compared against the mover's cached row (conditions 1-2) or col (conditions 3-4). Only lengths 5, 6 and 7 exist in the tree, and every 6-element entry uses NO_OTHER_CONDITIONS (no threshold needed). Cited: kod/object/active/holder/room.kod:222-224 (property comment, which only documents the 5-element form) and 2645-2752 (the reader).
- plExits POSITION-BY-POSITION: [1] trigger row in THIS room, [2] trigger col in THIS room, [3] destination piRoom_num OR the sentinel ROOM_LOCKED_DOOR(-1), [4] destination row (or, when slot 3 is -1 and Length=4, a message resource id), [5] destination col, [6] angle modifier, [7] max distance (DISTANCE_NORMAL) which is never read. Cited: kod/object/active/holder/room.kod:217-220 (comment) and 2771-2830 (reader). CreateYellZoneList independently confirms slot 3 is a RID and that negatives mean locked doors: 'iRID = Nth(i,3); % Locked doors are less than 0' (room.kod:948-970).
- DESTINATIONS ARE ROOM NUMBERS, NOT OBJECT IDS. Both tables store piRoom_num and are resolved at traversal time by Send(SYS,@FindRoomByNum,#num=...). FindRoomByNum lives in kod/util/system.kod:1238-1241 and is a one-liner: return GetTableEntry(phRooms,num). phRooms is a hash table built by iterating plRooms and AddTableEntry(phRooms, GetRoomNum(i), i) at system.kod:753-757, with incremental adds at system.kod:2003 and 2014 and removal at 2504. So RIDs survive save/restore; the room OBJECT ids that appear on the wire do not correspond to RIDs at all.
- LIST ORDER IS REVERSED RELATIVE TO SOURCE. Rooms build both tables with Cons (prepend), so the LAST line in CreateStandardExits is the FIRST element iterated. For conditional plEdge_Exits this decides which condition wins (first match breaks). Example: kod/object/active/holder/room/monsroom/d5.kod:76-82.
- ANGLE BUG WORTH KNOWING: StandardLeaveDir reads the angle modifier as Nth(i,5) AFTER the for-loop (room.kod:2736-2737). The compiler lowers 'for i in L' to temp=L; if temp=$ goto end; i=First(temp); ...; temp=Rest(temp) (blakcomp/codegen.c:474-545), so a natural loop exit leaves i = the LAST element of plEdge_Exits. Entries that fire via NO_OTHER_CONDITIONS do not break, so unless the NO_OTHER_CONDITIONS entry happens to be the last list element (i.e. the first one Cons'ed) the arrival FACING comes from a different entry. Destination room/row/col are unaffected (they are copied into locals before the break).
- TO SELECT AMONG CONDITIONAL EDGE EXITS, position yourself first, then step off. The comparison uses the mover's cached in-room row/col from BEFORE the off-grid move, because Room.SomethingMoved returns at room.kod:2232-2258 without ever reaching the position-update SetNth block. Concretely for kod/object/active/holder/room/monsroom/d7.kod:69-70: walking east from row < 20 lands in RID_E7, from row >= 20 lands in RID_JASWEST.
- EXITS ARE INVISIBLE TO THE PROTOCOL. Say this plainly to any consumer: there is no Door class anywhere in kod (find kod -iname '*door*' returns nothing; no 'X is Door' class declarations), no exit/door/teleport opcode or object flag in include/proto.h except OF_MOVEON_TELEPORTER at include/proto.h:417, and BP_ROOM_CONTENTS carries no exit markers. The ONLY protocol-observable exit is a Portal-family object, recognisable as (object.flags & 0x3) == 2. All Portal subclasses are kod/object/active/portal/{corpnode,corpport,hellport,necport,newbport}.kod plus kod/object/active/portal.kod; the only other MOVEON_TELEPORTER user is kod/object/active/spidtree.kod. Doors, stairs and lifts are grid squares in plExits plus sector/wall animations in the .roo, with nothing on the wire.
- ROWS/COLS ARE NOT ON THE WIRE, BUT ARE RECOVERABLE. BP_PLAYER gives roomRsc (a 4-byte resource id). Pipeline: (1) map the resource NAME to that id with kod/kodbase.txt, whose lines look like 'R\troom_JasperEast 22232' (line 6690); (2) map the id to the filename with the client .rsc files under run/localclient/resource/ — format is literal 'RSC\x01', version int32, count int32, then count x [id int32 LE, NUL-terminated string]; jasper.rsc yields 22232 -> "jas-east.roo" (verified by hexdump); (3) read resource/rooms/<file>.roo. Header: magic 'ROO\xB1'(4), version int32(4), security int32(4), main_off int32(4), server_off int32(4). piRows/piCols come from the SERVER section, not the client one: fseek(server_off), int32 rows, int32 cols (blakserv/roofile.c:330-340). The client section at main_off starts with int32 width, int32 height and the client derives cols = width>>10, rows = height>>10 (clientd3d/bspload.c:100-116). Verified consistent: jas-east.roo -> rows 72, cols 74; tos.roo -> 69/42; guest1.roo -> 8/11.
- THE .roo SERVER SECTION ALSO HANDS YOU A WALKABILITY MAP FOR FREE. Immediately after rows and cols come three rows x cols byte arrays (the third only for roo_version >= 12): grid[][] (per-square 8-way exit bitmask, MASK_NORTH=1 ... MASK_NORTH_WEST=128), flags[][] (bit 0 = ROOM_FLAG_WALKABLE), and monster_grid[][]. Arrays are 0-based, so kod square (row,col) is grid[row-1][col-1]. blakserv/roomdata.c:113-232 shows exactly how the server would interpret them (CanMoveInRoom). The server does not apply this to player moves, but it is the correct intra-room pathfinding graph and it tells you which edge squares are reachable.
- CANONICAL ROOM-NUMBER TABLE: there is no .txt or generated file. The authoritative sources are (a) kod/include/blakston.khd lines 373-866 for the RID_* -> integer mapping (531 RID_ lines including aliases; note deliberate duplicates such as RID_VICTORIA=RID_CASTLE1=38 and RID_UNDERWORLD=RID_DEFAULT=1), plus an alias block at 874-999 giving .roo-flavoured names; (b) kod/util/system.kod:2027 onward, CreateAllRoomsIfNew, which is a flat list of ~262 'Send(self,@CreateOneRoomIfNew,#num=RID_X,#class=&ClassY)' lines and is the closest thing to a room registry; (c) each room class file, which declares 'prRoom = room_XXX' and 'piRoom_num = RID_XXX' in its properties block, e.g. kod/object/active/holder/room/jasperrm/jasper.kod:39-40 with 'room_JasperEast = jas-east.roo' at line 21. 281 .kod files live under kod/object/active/holder/room/ and 532 .roo files under resource/rooms/.
- TWO RID->prRoom COLLISION TRAPS when keying a graph off roomRsc. (1) Newbie rooms are SUBCLASSES of guest rooms and inherit prRoom, so RID_GUEST1(1001) and RID_NEWB1(1011) both report room_guest1 (kod/object/active/holder/room/guest1.kod:63-64 vs guest1/newb1.kod:31-32). They differ only in vrName (roomNameRsc). (2) All rentable rooms share prRoom = RentableRoom_roo and get piRoom_num assigned at construction from RID_RENTABLE_START+n (kod/object/active/holder/room/rentroom.kod:202, 238-240). Use the pair (roomRsc, roomNameRsc) plus the room object id to disambiguate.
- GUEST/NEWBIE EXITS ARE NOT STATICALLY EXTRACTABLE FROM THE SOURCE LINE ALONE. 29 plExits entries use 'viDemo_base + N' as the destination instead of a literal RID. viDemo_base is a classvar overridden per subclass: RID_GUEST_BASE(1000) in guestN.kod, RID_NEWB_BASE(1010) in newbN.kod (kod/object/active/holder/room/guest1.kod:59 vs guest1/newb1.kod:28; example use at guest1.kod:87). The same source line therefore produces two different edges depending on which subclass is instantiated.
- ROOM ARRIVAL POINT FOR ALL TELEPORTS: Room.Teleport sends UtilGoNearSquare to viTeleport_row / viTeleport_col / viTeleport_angle, which default to $ and are set per room class (kod/object/active/holder/room.kod:172-174, 760-772, 786-802). If either row or col is $ the teleport is refused with room_no_teleport. These three classvars are the canonical 'safe spawn' node for each room and are worth harvesting alongside the exit tables.
- TRAVEL WITHOUT WALKING, complete list of what a PLAYER can reach: (1) BP_USERCOMMAND(155) + UC_REQ_RESCUE(41), no payload, no cost, teleports you to your homeroom via AdminGoToSafety — but only if you are not already there (user.kod:1930-1946, 7076-7107). (2) Elusion, SID_ELUSION=169, BP_REQ_CAST(105) from a town centre or your guild hall, then BP_SAY_TO(110) with the destination room's name during the trance; teleports to any of 1-6 randomly offered town centres plus optionally Kocatan and your guild hall (kod/object/passive/spell/elusion.kod:85-215). (3) Rescue, SID_RESCUE=7, posts @Teleport to a region-appropriate safe room: RID_KOC_INN for RID_KOCATAN region or RID_ORC_CAVE5_EXT, RID_ORC_CAVE5_EXT for RID_ORC_CAVE1 region (kod/object/passive/spell/rescue.kod:120-160). (4) Blink, SID_BLINK=32, teleports you to your CURRENT room's viTeleport square, with two hardcoded cross-room special cases: RID_KOC_HALL_OF_HEROES -> RID_TOS_FORGET and RID_BAZMANS_ROOM -> RID_FORGOTTEN_TOO (kod/object/passive/spell/blink.kod:60-92). (5) Portal objects: just walk onto the square. Underworld holds five fixed inn portals to RID_TOS_INN / RID_COR_INN / RID_BAR_INN / RID_MAR_INN / RID_JAS_INN (kod/object/active/holder/room/monsroom/uworld.kod:649-661); other Portals at gallery.kod:77-78, i9.kod:344, canyon2.kod:82, univ.kod:49. (6) Dying: UserGotoDeadRoom drops you at RID_UNDERWORLD row 24 col 10 (or RID_NEWB1 if you were in the newbie region) — reachable deliberately via BP_USERCOMMAND + UC_SUICIDE(8) (user.kod:2280-2320). (7) Portal of Life, SID_PORTAL_OF_LIFE=110, spawns a CorpsePortal in RID_UNDERWORLD at row 16 col 16 that returns a dead player to their body (kod/object/passive/spell/portlife.kod:86-100). (8) Black dagger sends its victim to RID_UNDERWORLD (kod/object/item/passitem/weapon/bkdagger.kod:352). NOT player-reachable: Player.TeleportTo (user.kod:7189-7210) and AdminGoToSafety/AdminGoToOOG/AdminGoToObject are admin-socket / DM-only; there is no client opcode for them. There is no Nexus travel system — 'Nexus' appears only in lore strings. Logging off records piSave_room = the room you left and logging on restores you to the same square (user.kod:710-715, 2192-2218), so it preserves position rather than providing travel.
- AGENT PROCEDURE FOR ONE GRAPH HOP. Edge crossing: send BP_REQ_MOVE with a coordinate one square outside the bound (wire value 0 for row/col 0, or (piRows+1)*64+64 for past the south edge) and the correct roomObjectId; the server will not reject it. Doorway: send BP_REQ_MOVE to land exactly on the trigger square, then send BP_REQ_MOVE again (or rely on it already matching) and then the single byte 102. In both cases success is signalled by a fresh BP_PLAYER(130) followed by BP_ROOM_CONTENTS(134); failure by BP_MESSAGE carrying user_cant_go, or by nothing at all when there is no plEdge_Exits entry for that edge.

### Not determined

- I did not find any file in the tree that enumerates RID -> room name -> .roo filename in one place. I searched for *.txt / rooms* / *.rid (find -iname 'rooms*' -o -iname '*room*.txt' -o -iname '*.rid') and looked at doc/, doc/design/, run/server/ (blakserv.cfg, packages.txt, rsc/, loadkod/, memmap/) and resource/. The only room-table-ish artefacts are doc/design/Mechanics/rooms.htm and doc/design/Updates/Revelations/original map/rooms1.htm, which I did not read and which are design documents rather than generated tables. If a canonical table is wanted it has to be generated from blakston.khd + system.kod CreateAllRoomsIfNew + the per-class prRoom/piRoom_num declarations.
- I did not exhaustively enumerate the per-room SomethingTryGo overrides. grep found roughly 44 rooms overriding it (kod/object/active/holder/room/**), and I read only ghall.kod:981, guildh1.kod:104, kocinn.kod:85, f8.kod:106 and barjail/castle2a/duke2/duke3/dungeon by name. Some of these certainly contain hardcoded cross-room UtilGoNearSquare calls that are not in plExits or plEdge_Exits; a complete graph needs each one read individually.
- I did not verify whether kod's AND short-circuits. It matters only for 6-element plEdge_Exits entries, where Nth(i,7) does not exist; since all 7 such entries in the tree use NO_OTHER_CONDITIONS(5) the threshold-comparing branches are never reached in practice, but a hand-authored 6-element entry with condition 1-4 would evaluate Nth(i,7) on a short list.
- I did not determine whether the client ever receives .roo or .rsc files at runtime rather than shipping with them. run/server/packages.txt is a patch manifest (zip -> client subdirectory) which suggests they are downloaded out of band; I read only its header comment. An agent that lacks the client resource tree may not be able to resolve roomRsc -> filename at all, and I did not look for a protocol path that sends the filename string.
- I could not find any message named RoomObjOffGrid despite the comment at kod/object/active/holder/room.kod:2053 referring to it. It appears to be a stale comment; the bounds handling now lives inline in Room.SomethingMoved.
- I did not chase how BP_SPELLS / BP_SPELL_ADD deliver the spell OBJECT ids that BP_REQ_CAST needs, since those are parsed in module/merintr/merintr.c rather than clientd3d/server.c. An agent wanting to cast Elusion or Rescue needs that mapping and I have not documented it.
- I did not confirm the exact sector/wall animation packets a client would see when a room-override SomethingTryGo opens a lift-style door in place (SetSector / ANIMATE_FLOOR_LIFT paths in room.kod). This is the only observable evidence that a 'go' succeeded without changing rooms, and I have not verified its wire format.


---

## Groups, parties, and multi-recipient communication (BP_SAY_GROUP / BP_SAID / guilds)

Meridian 59 has NO server-side party/group concept. What the client calls a "group" is purely a list of character-name strings stored in the client's own INI file (module/merintr/groups.c:20-23); at send time the client resolves those names to object ids out of its own who-list and emits a single BP_SAY_GROUP with an id list, so the server never learns a group exists. The only server-side collective is the GUILD (kod/object/passive/guild.kod), and even guild chat is implemented by expanding the guild roster client-invisibly into the same UserSayGroup path (user.kod:4133-4164). A private tell is exactly BP_SAY_GROUP with a one-element id list (module/merintr/command.c:128-132); there is no separate tell opcode. On the receive side every one of these arrives as BP_SAID with say_type == SAY_GROUP(4) — the server rewrites SAY_GROUP_ONE(8) to 4 before sending (user.kod:6486) — so the only wire discriminator between "X tells you", "X sends" (group), and "X sends" (guild) is the format-resource id embedded in the payload, and guild vs. multi-target group send are byte-for-byte indistinguishable. There is no BP_RECIPIENTS opcode anywhere in include/proto.h; HandleRecipients is a vestigial prototype in clientd3d/server.h:90 with no definition and no caller. There is absolutely no shared XP, shared loot, damage-credit split, or formation mechanic: loot drops on the room floor as free-for-all (monster.kod:5027-5040), advancement is per-character skill/spell use, and the only mechanical group effects are guild-war kill legality, revenant chance, and minimap ring colors. Coordination between agents must therefore be an invented convention layered on tells/guild chat.

### Wire formats

**BP_SAY_GROUP (111) — client->server**

```
opcode(1)=111 | numRecipients(2, LE) | recipientId[0](4) ... recipientId[n-1](4) | msgLen(2) | msgBytes(msgLen, no NUL)
```

*blakserv/sprocket.c:28 `{ BP_SAY_GROUP, { {2, LIST_OBJ_PARM}, {0,TAG_TEMP_STRING}, {0, DONE_PARM} } }`; client emitter clientd3d/protocol.c:44 (PARAM_ID_LIST, PARAM_STRING) with PARAM_ID_LIST encoded at clientd3d/protocol.c:290-296 and the string at clientd3d/protocol.c:109-116; kod dispatch kod/object/active/holder/nomoveon/battler/player/user.kod:1033-1040*

CONFIRMED as {2,LIST_OBJ_PARM}+temp string. The ids ARE player object ids (BP_PLAYERS ids), but the server only requires that each id resolve to a live object (blakserv/parsecli.c:291-299) - it does NOT require &Player, does not require the target be in your room, and does not require them to be logged on. DESYNC/GOTCHA 1: LIST_OBJ_PARM elements are read as 4 bytes each, and if the top nibble of an element equals CLIENT_TAG_NUMBER(1) the server consumes 4 MORE bytes as an amount (blakserv/parsecli.c:301-311). Player ids have tag 0 so in practice each element is 4 bytes. GOTCHA 2: object lists are built with Cons so the kod list is the REVERSE of wire order (blakserv/parsecli.c:283-285 comment) - kod's First(users) is the LAST id you put on the wire, which matters for the DM-hidden warning at user.kod:4194-4201. GOTCHA 3: if ANY id in the list fails GetObjectByID the whole message is dropped with only a server-log eprintf and no reply. String is a temp string, truncated to LEN_TEMP_STRING=6000 (blakserv/string.c:246-248, blakserv/blakserv.h:87).

**BP_SAY_TO (110) — client->server**

```
opcode(1)=110 | sayType(1) | msgLen(2) | msgBytes(msgLen)
```

*blakserv/sprocket.c:27 `{ BP_SAY_TO, { {1, TAG_INT}, {0,TAG_TEMP_STRING}, {0, DONE_PARM} } }`; kod dispatch user.kod:1024-1031 -> UserSay; client emitters module/merintr/command.c:39,51,63,75,655 and module/dm/command.c:124,134*

This is the channel selector for everything that is not an explicit id list. sayType is the SAY_* enum: 1=SAY_NORMAL (room), 2=SAY_YELL (room + plYell_Zone rooms), 3=SAY_EVERYONE (server-wide broadcast), 6=SAY_EMOTE, 7=SAY_MESSAGE, 9=SAY_DM (admin command channel), 10=SAY_GUILD (guild chat). SAY_GUILD is handled at user.kod:4065-4070 by re-dispatching into UserSayGuild. SAY_RESOURCE(5) and SAY_GROUP(4)/SAY_GROUP_ONE(8) are never sent by a client here. An unrecognised type falls through to `Debug("Got unknown user say type")` at user.kod:4128 and does nothing. NOT rate-limited: unlike many opcodes, BP_SAY_TO and BP_SAY_GROUP are not gated on the bSpam flag (compare user.kod:1024-1040 with e.g. user.kod:1005-1011).

**BP_SAID (recipient of a group tell or guild tell) (206) — server->client**

```
opcode(1)=206 | senderObjId(4) | senderNameRsc(4) | sayType(1)=4 | fmtRsc(4) | senderNameRsc(4) again | strLen(2) | strBytes(strLen)
```

*kod send: user.kod:6528-6533 `AddPacket(1,BP_SAID, 4,what, 4,rName, 1,type, 4,rSay_format, 4,rName, 0,string)`; format chosen at user.kod:6459-6472 (SAY_GROUP -> user_send_str) and user.kod:6474-6487 (SAY_GROUP_ONE -> user_send_one_str, then `type = SAY_GROUP`); C parse: clientd3d/server.c:878-900 then clientd3d/srvrstr.c:31-243*

The trailing fmtRsc+params block is NOT fixed length - it is driven by the format resource. user_send_str = "%s sends, \"%q~n\"" (user.kod:102) and user_send_one_str = "%s tells you, \"%q~n\"" (user.kod:103); both are exactly one %s (4-byte resource id) then one %q (2-byte length + bytes). So both variants have IDENTICAL byte layout and identical sayType=4. The ONLY discriminator is fmtRsc. A guild send produces user_send_str, i.e. it is byte-identical to a multi-recipient group send. HandleSaid does `len -= 2*SIZE_ID + SIZE_SAY_INFO` at clientd3d/server.c:893 and never subtracts the 4-byte fmtRsc, so the length it hands CheckServerMessage is 4 too large; CheckServerMessage only uses len for bounds checks and HandleSaid never verifies full consumption, so trailing bytes are silently tolerated. senderNameRsc is the resource id of the sender's name and is only resolvable if the client previously received BP_PLAYERS/BP_PLAYER_ADD for that player (which calls ChangeResource, clientd3d/server.c:1112,1142). If the sender has PFLAG_ANONYMOUS set, senderNameRsc is the shared literal user_cap_Someone_string ("Someone", user.kod:89) rather than their name (User GetName, user.kod:492-506) - so anonymity defeats the client-side ignore list, which is keyed on the name resource (clientd3d/msgfiltr.c:246-247).

**BP_SAID (sender's own echo, multi-recipient group send OR guild send) (206) — server->client**

```
opcode(1)=206 | senderObjId(4)=self | senderNameRsc(4) | sayType(1)=4 | fmtRsc(4)=user_send_echo_str | strLen(2) | strBytes(strLen)
```

*user.kod:4182 `AddPacket(1,BP_SAID,4,self,4,vrName,1,SAY_GROUP);` then user.kod:4188-4191 `AddPacket(4,user_send_echo_str, 0,string);`*

user_send_echo_str = "You send, \"%q~n\"" (user.kod:108) - one %q only, no %s, so there is NO extra 4-byte field here, unlike the one-recipient echo. Chosen whenever Length(users) != 1 OR no_tell is TRUE. Because guild sends always pass no_tell=TRUE (user.kod:4161), the sender cannot tell from their own echo whether they guild-sent or group-sent.

**BP_SAID (sender's own echo, single-recipient tell) (206) — server->client**

```
opcode(1)=206 | senderObjId(4)=self | senderNameRsc(4) | sayType(1)=4 | fmtRsc(4)=user_send_single_echo_str | targetNameRsc(4) | strLen(2) | strBytes(strLen)
```

*user.kod:4182 then user.kod:4183-4187 `AddPacket(4,user_send_single_echo_str, 4,Send(First(users),@GetTrueName), 0,string);`*

user_send_single_echo_str = "You tell %s, \"%q~n\"" (user.kod:109) - %s consumes the 4-byte targetNameRsc, %q consumes the 2+N string. Note this uses GetTrueName, so the echo shows the real name even for an anonymous/morphed target. Taken only when Length(users)==1 AND NOT no_tell.

**BP_SAY_BLOCKED (55) — client->server**

```
opcode(1)=55 | senderObjId(4)
```

*blakserv/sprocket.c:69 `{ BP_SAY_BLOCKED, { {4, TAG_OBJECT}, {0, DONE_PARM} } }`; client sender clientd3d/protocol.h:107 + clientd3d/msgfiltr.c:250-254; kod dispatch user.kod:1312-1318 -> UserBlockedSend*

Sent by the stock client to tell the server 'I suppressed a send from this player'. The kod handler UserBlockedSend at user.kod:3754-3759 is an empty stub with no override anywhere in the tree, so this message has NO effect. An agent can simply never send it.

**BP_PLAYERS (136) — server->client**

```
opcode(1)=136 | count(2) | count x { objId(4) | nameRsc(4) | nameLen(2) | nameBytes(nameLen) | objectFlags(4) }
```

*kod send: user.kod:2517-2547 (`AddPacket(1,BP_PLAYERS,2,Length(lUsers))` then per user `AddPacket(4,i, 4,rName, STRING_RESOURCE,rName)` and `AddPacket(4,Send(i,@GetObjectFlags) & ~DRAWFX_INVISIBLE)`); C parse clientd3d/server.c:1090-1128*

This is the ONLY name->object-id table the client has, and it is how a tell target is named. Requested with BP_SEND_PLAYERS(44), no payload (blakserv/sprocket.c:56). Server-wide: it is every logged-on user, not just the current room, EXCEPT hidden DMs are filtered out unless the viewer IsClass Admin (user.kod:2525-2532). The 4-byte nameRsc must be recorded by the client - ChangeResource(nameRsc, nameBytes) at clientd3d/server.c:1112 - or later BP_SAID senderNameRsc values are unresolvable. objectFlags carries the per-viewer OF_GUILDMATE/OF_FRIEND/OF_ENEMY bits.

**BP_PLAYER_ADD (137) — server->client**

```
opcode(1)=137 | objId(4) | nameRsc(4) | nameLen(2) | nameBytes(nameLen) | objectFlags(4)
```

*kod send user.kod:800-805; C parse clientd3d/server.c:1130-1155*

Same record shape as one BP_PLAYERS entry. Sent on every login. Guild membership is also announced out-of-band: user.kod:813-817 sends a BP_MESSAGE (user_guildmate_logon, "~IHail your guildmate %s!") to each logged-on guildmate, and user.kod:838-843 the matching logoff message. That is a free guildmate-presence signal an agent can parse.

**BP_PLAYER_REMOVE (138) — server->client**

```
opcode(1)=138 | objId(4)
```

*kod send user.kod:844*

Sent after the guildmate-logoff BP_MESSAGE, so ordering is: guildmate notice, then removal.

**BP_USERCOMMAND framing (155) — client->server**

```
opcode(1)=155 | subOpcode(1) | sub-opcode-specific parameters
```

*blakserv/sprocket.c:76 `{ BP_USERCOMMAND, { {0, USERCOMMAND_TABLE_PARM} } }`; redirect logic blakserv/parsecli.c:141-152; kod entry user.kod:865-897 (type==1 -> UserCommand) then user.kod:1465-1469 `iClient_cmd = First(client_msg)`*

Same framing in the reverse direction: `AddPacket(1,BP_USERCOMMAND,1,<UC_*>)` then payload. Client-side sub-dispatch is module/merintr/merintr.c:1217-1247 (1 byte, `len - SIZE_TYPE` handed to the handler). A sub-opcode absent from blakserv/sprocket.c usercommand_def_table is rejected at blakserv/parsecli.c:159-164 with only a server-log line.

**UC_REQ_GUILDINFO (10) — client->server**

```
155 | 10 | (no payload)
```

*blakserv/sprocket.c:104; kod user.kod:1569-1579 -> UserGuildSendInfo*

bSpam-gated: silently dropped if you exceeded INCOMING_PACKET_THROTTLE=5 packets in the current second (user.kod:1571-1574). Replies UC_GUILDINFO, or a BP_MESSAGE user_no_guild ("You do not belong to a guild.", user.kod:227) if unguilded.

**UC_GUILDINFO (11) — server->client**

```
155 | 11 | guildNameLen(2)+bytes | hasPassword(1) | [ if hasPassword: pwLen(2)+bytes ] | guildCommandFlags(4) | guildObjId(4) | 10 x { rankNameLen(2)+bytes } | myCurrentVoteObjId(4, 0 = not supporting anyone) | numMembers(2) | numMembers x { memberObjId(4) | nameLen(2)+bytes | rank(1) | gender(1) }
```

*kod send user.kod:1968-2031; C parse module/merintr/merintr.c:1251-1308*

OPTIONAL FIELD HAZARD: the password block is present only when hasPassword==1, which requires BOTH that the guild owns a hall AND that you are RANK_MASTER (user.kod:1980-1990). The 10 rank names are in the fixed order Apprentice-male, Apprentice-female, Sir, Madame, Lord, Lady, Lieutenant-male, Lieutenant-female, Master, Mistress (guild.kod:1195-1200) - i.e. 5 ranks x (male,female), matching NUM_GUILD_RANKS=5 read as pairs at merintr.c:1271-1275. The vote field is emitted inside a loop over members that matches self (user.kod:2004-2019); if for some reason you are not in your own guild's member list this field is ABSENT and everything after desynchronises. guildCommandFlags is the GCID_* bitmask of commands you personally hold (piGuild_commands); client mirrors them as GC_* in module/merintr/guild.h:23-34 with identical values. rank is 1..5 (RANK_APPRENTICE..RANK_MASTER).

**UC_INVITE (12) — client->server**

```
155 | 12 | targetPlayerObjId(4)
```

*blakserv/sprocket.c:105; kod user.kod:1581-1591 -> UserGuildCommand(GCID_INVITE=0x01); handler kod/object/passive/guildcmd/gcinvite.kod:60-121*

Requires RANK_LORD (gcinvite.kod:48). bSpam-gated. Does NOT add the member: it creates a &GuildInvitation ActiveItem in the target's inventory (gcinvite.kod:117-118). The target accepts by BP_REQ_USE(106) on that item's id - ITEM_SINGLE_USE routes Use into TryApplyItem/NewApplied (player.kod:3325-3328, invitat.kod:174-190). The invitation self-deletes after 120000 ms (invitat.kod:16, 74-78) and also vanishes the moment EITHER party leaves the room (invitat.kod:149-166) or the inductor logs off (invitat.kod:93-98).

**UC_EXILE (13) — client->server**

```
155 | 13 | targetPlayerObjId(4)
```

*blakserv/sprocket.c:107; kod user.kod:1601-1607 -> GCID_EXILE=0x02; rank gate kod/object/passive/guildcmd/gcexile.kod:47 (RANK_LIEUTENANT), disabled for Necromancer guild (gcexile.kod:49)*

NOT bSpam-gated.

**UC_RENOUNCE (14) — client->server**

```
155 | 14 | (no payload)
```

*blakserv/sprocket.c:106; kod user.kod:1594-1599 -> GCID_RENOUNCE=0x04; gcrennce.kod:42 RANK_APPRENTICE*

Leaving costs you: CANNOT_REJOIN_TIME = 4*60 minutes before joining any guild, and 18x that for the same guild (guild.kod:19-20). Also flips PK status via EvaluatePKStatus (player.kod:1047-1106) since guild membership forces PFLAG_PKILL_ENABLE.

**UC_ABDICATE (15) — client->server**

```
155 | 15 | successorPlayerObjId(4)
```

*blakserv/sprocket.c:108; kod user.kod:1609-1615 -> GCID_ABDICATE=0x40; gcabdic.kod:51 RANK_MASTER, gcabdic.kod:52 necro-disabled*

NOT bSpam-gated.

**UC_VOTE (16) — client->server**

```
155 | 16 | candidatePlayerObjId(4)
```

*blakserv/sprocket.c:109; kod user.kod:1617-1628 -> GCID_VOTE=0x20; gcvote.kod:39 RANK_APPRENTICE*

bSpam-gated. Votes are tallied on the guild MaintenanceTimer (guild.kod:637 CountVotes), not immediately. Only meaningful when the guild's piSuccession is GS_VOTING(1) (guild.kod:2297, blakston.khd:2297-2298).

**UC_SET_RANK (17) — client->server**

```
155 | 17 | targetPlayerObjId(4) | newRank(1)
```

*blakserv/sprocket.c:110; kod user.kod:1630-1636 -> GCID_SET_RANK=0x1000 with #data=newRank; handler gcsetrnk.kod:51-101*

NOT bSpam-gated. Rules enforced in gcsetrnk.kod: target must be a &Player (gcsetrnk.kod:56-61), same guild (64-72), not yourself (74-78), target's CURRENT rank must be strictly below yours (84-88), and newRank must be strictly below yours (90-94). Requires RANK_LIEUTENANT (gcsetrnk.kod:41). Additional caps in guild.kod: MAX_LIEUTENANT=2 (guild.kod:47), MAX_MEMBERS=400 (guild.kod:23).

**UC_GUILD_ASK (18) — server->client**

```
155 | 18 | guildPrice(4) | secretGuildPrice(4)
```

*kod send user.kod:5791-5799 (SendCreateGuild); C parse module/merintr/merintr.c:1310-1322 (asserts len==8)*

PUSH ONLY - there is no client->server UC_GUILD_ASK entry in blakserv/sprocket.c, so you cannot request it. It is emitted only from the Guildmaster NPC in Barloque: kod/object/active/holder/nomoveon/battler/monster/towns/barlqtwn/gcreator.kod:321, reached by a BP_REQ_BUY on that NPC (its GetForSale hook). Values are 5000 and 7500 (see constants).

**UC_GUILD_CREATE (19) — client->server**

```
155 | 19 | guildName(2+N) | apprenticeMale(2+N) | apprenticeFemale(2+N) | sir(2+N) | madame(2+N) | lord(2+N) | lady(2+N) | lieutenantMale(2+N) | lieutenantFemale(2+N) | master(2+N) | mistress(2+N) | secret(1)
```

*blakserv/sprocket.c:111-115 (11 x {0,TAG_STRING} then {1,TAG_INT}); kod user.kod:1638-1709; client emitter table module/merintr/merintr.c:100-102*

Eleven length-prefixed strings then one byte, twelve params total. Argument order is fixed by user.kod:1691-1701: Nth(client_msg,2)=guild name, 3=Apprentice male, 4=Apprentice female, 5=Sir, 6=Madame, 7=Lord, 8=Lady, 9=Lieutenant male, 10=Lieutenant female, 11=Master, 12=Mistress, 13=secret flag. All checks happen in user.kod, not in the Guild constructor. Strings here are TAG_STRING (permanent), unlike say strings which are TAG_TEMP_STRING.

**UC_DISBAND (20) — client->server**

```
155 | 20 | (no payload)
```

*blakserv/sprocket.c:116; kod user.kod:1711-1716 -> GCID_DISBAND=0x2000; gcdisbnd.kod:39 RANK_MASTER, gcdisbnd.kod:40 necro-disabled*

Also forced automatically if a guildmaster is suicided (user.kod:1433-1438).

**UC_REQ_GUILD_LIST (21) — client->server**

```
155 | 21 | (no payload)
```

*blakserv/sprocket.c:121; kod user.kod:1770-1775 -> UserGuildSendList*

NOT bSpam-gated.

**UC_GUILD_LIST (22) — server->client**

```
155 | 22 | numGuilds(2) | numGuilds x { guildObjId(4) | nameLen(2)+bytes } | numAllies(2) | numAllies x guildObjId(4) | numEnemies(2) | numEnemies x guildObjId(4) | numDeclaredAllies(2) | numDeclaredAllies x guildObjId(4) | numDeclaredEnemies(2) | numDeclaredEnemies x guildObjId(4)
```

*kod send user.kod:2033-2078; C parse module/merintr/merintr.c:1324-1367 (fixed loop `for (i=0; i<4; i++)`)*

Exactly four id-list blocks after the named-guild block, in the order ally / enemy / declaredAlly / declaredEnemy (user.kod:2044,2051,2058,2065-2072). Secret guilds are NOT filtered from the first list (SYS GetGuilds just returns plGuilds, kod/util/system.kod:4181-4184). If the caller has no guild, the four Send(poGuild,...) calls are on $ and the counts come back 0 - the message is still well-formed.

**UC_MAKE_ALLIANCE / UC_END_ALLIANCE / UC_MAKE_ENEMY / UC_END_ENEMY (23) — client->server**

```
155 | <23|24|25|26> | otherGuildObjId(4)
```

*blakserv/sprocket.c:117-120; kod user.kod:1718-1768 mapping to GCID_FORGE_ALLIANCE=0x100, GCID_END_ALLIANCE=0x200, GCID_DECLARE_ENEMY=0x400, GCID_PEACE=0x800; rank gate RANK_LIEUTENANT for all four (gcally.kod:48, gcnoally.kod:39, gcenemy.kod:39, gcnoenem.kod:39)*

All four are bSpam-gated (user.kod:1720-1723 etc.). The target is a GUILD object id, obtained from UC_GUILD_LIST. Alliance is one-directional and only counts as a real alliance when BOTH sides declare (user.kod:2412-2416 requires IsAlly in both directions before setting OF_FRIEND). Backing out of a mutual war costs WAR_LOSS_PENALTY=50000 and cannot be done for PEACE_DELAY = 2*60*60*1000 ms (guild.kod:30-31, 50-52).

**UC_GUILD_HALLS (27) — server->client**

```
155 | 27 | numHalls(2) | numHalls x { hallObjId(4) | nameRsc(4) | cost(4) | rent(4) }
```

*kod send user.kod:5757-5788 (SendBuyGuildHall); C parse module/merintr/merintr.c:1422-1447*

PUSH ONLY - no client->server entry in blakserv/sprocket.c. Emitted from gcreator.kod:288 when a RANK_LIEUTENANT+ member of a MATURE guild with no hall does a BP_REQ_BUY on the Barloque Guildmaster. rent is sent as 24 * GetRentValue (user.kod:5779). nameRsc is a 4-byte resource id, NOT an inline string.

**UC_ABANDON_GUILD_HALL (28) — client->server**

```
155 | 28 | (no payload)
```

*blakserv/sprocket.c:123; kod user.kod:1836-1841 -> GCID_ABANDON_HALL=0x4000; gcaband.kod:38 RANK_LIEUTENANT, gcaband.kod:40 necro-disabled*

**UC_GUILD_RENT (29) — client->server**

```
155 | 29 | guildHallObjId(4) | passwordLen(2)+bytes
```

*blakserv/sprocket.c:122; kod user.kod:1815-1834*

Not routed through UserGuildCommand at all - user.kod checks money directly (GetPurchaseValue vs GetMoneyObject) and refuses with BP_MESSAGE user_no_guildhall_broke. Only subtracts money if ClaimGuildHall returns true (user.kod:1826-1830).

**UC_GUILD_SET_PASSWORD (30) — client->server**

```
155 | 30 | passwordLen(2)+bytes
```

*blakserv/sprocket.c:124; kod user.kod:1843-1855 -> GCID_SET_PASSWORD=0x8000*

Rejected server-side (Debug + return, no client message) if length > MAX_GUILD_NAME_LEN=30 (user.kod:1846-1850).

**UC_GUILD_SHIELDS (32) — client->server**

```
155 | 32 | (no payload)
```

*blakserv/sprocket.c:112 region - specifically blakserv/sprocket.c line for UC_GUILD_SHIELDS at blakserv/sprocket.c:113; kod user.kod:1777-1782*

Bidirectional opcode number. Reply is UC_GUILD_SHIELDS server->client: `155 | 32 | numSamples(2) | numSamples x iconRsc(4)` (user.kod:2081-2098; parse module/merintr/merintr.c:1408-1420).

**UC_GUILD_SHIELD (31) — client->server**

```
155 | 31 | (no payload)
```

*blakserv/sprocket.c:114; kod user.kod:1784-1789*

Reply is UC_GUILD_SHIELD server->client: `155 | 31 | guildObjId(4, or 0 if shield unclaimed) | guildNameLen(2)+bytes | color1(1) | color2(1) | shape(1)` (user.kod:2101-2140; parse module/merintr/merintr.c:1369-1393). Note that when the shield is unclaimed the id is 0 but the NAME sent is still your own guild's name (user.kod:2130-2135 comment).

**UC_CLAIM_SHIELD (33) — client->server**

```
155 | 33 | color1(1) | color2(1) | shape(1) | doClaim(1)
```

*blakserv/sprocket.c:115; kod user.kod:1791-1813*

Claims the color/shape triple for YOUR guild only if no other guild already holds it AND the 4th byte is non-zero (user.kod:1798-1806). Always replies UC_GUILD_SHIELD. Guild shields are the public heraldry: reading a shield names the owning guild only if that guild is NOT secret (kod/object/item/passitem/defmod/shield/guilshld.kod:216-224).

**BP_REQ_LOOKUP_NAMES (88) — client->server**

```
opcode(1)=88 | expectedCount(2) | commaSeparatedNamesLen(2) | bytes
```

*blakserv/sprocket.c:70; kod user.kod:1321-1327 -> UserLookupNames at user.kod:4394-4405*

This is the server-side name resolver, and it is strictly more powerful than the who-list: it resolves against phUsers, the hash of ALL characters ever created (kod/util/system.kod:1403-1406, populated in SystemUserCreate at system.kod:924-930), so it returns object ids for OFFLINE characters too. DESYNC HAZARD: the server echoes your expectedCount verbatim into the reply header (user.kod:4398) but then writes one 4-byte id per comma-separated token via ParseString (user.kod:4400). If expectedCount disagrees with the number of tokens the reply is malformed. Also the literal name "guild" (user_guild_rsc) resolves to your own guild OBJECT id (user.kod:4411-4415), which is how guild-wide mail is addressed.

**BP_LOOKUP_NAMES (190) — server->client**

```
opcode(1)=190 | count(2) | count x objId(4)  (0 for each unresolved name)
```

*kod send user.kod:4397-4402; C parse module/mailnews/mailnews.c:323-350*

An unresolved name yields a literal 0 in that slot (user.kod:4429-4432), so slots are positional against your comma-separated input order. Client rejects count > MAX_RECIPIENTS=20 (mailnews.c:332-336, mail.h:18).

**BP_SEND_MAIL (82) — client->server**

```
opcode(1)=82 | numRecipients(2) | numRecipients x objId(4) | bodyLen(2)+bytes
```

*blakserv/sprocket.c:40 `{ BP_SEND_MAIL, { {2, LIST_OBJ_PARM}, {0, TAG_STRING}, {0, DONE_PARM} } }`; kod user.kod:1055-1062 -> UserMail at user.kod:4501-4522; client emitter module/mailnews/mailnews.c:50 uses PARAM_ID_ARRAY (clientd3d/protocol.c:249-259)*

The other multi-recipient channel, and the only OFFLINE-capable one. Same LIST_OBJ_PARM caveats as BP_SAY_GROUP (reverse order in kod, ids must resolve). Addressing the guild object id instead of a player id fans the message out to every member via Guild.ReceiveMail (kod/object/passive/guild.kod:1081-1095). No mana cost, no rank check. Client caps at MAX_RECIPIENTS=20 but the server does not.

**BP_MESSAGE (32) — server->client**

```
opcode(1)=32 | fmtRsc(4) | then one field per format specifier in fmtRsc (%s/%d/%i = 4 bytes; %q = 2-byte length + bytes)
```

*kod send user.kod:3207-3240 (MsgSendUser); C parse clientd3d/server.c:855-869 (HandleStringMessage) via clientd3d/srvrstr.c:31*

Every guild/group refusal listed in the rules below arrives as one of these. There is no error code - you must match on the resource id, which is a per-build compiled constant, or on the rendered English text.

### Rules, in the order the server checks them

| | rule | where |
|---|---|---|
| message | There is no server-side group/party object of any kind. A 'group' is a name -> list-of-character-names mapping stored in the client's own INI file under section [Groups]; sending to one just expands to a BP_SAY_GROUP id list. Max 30 groups of up to 100 names each, group name max 10 chars. | `module/merintr/groups.c:9-11 header comment and groups.c:20-23; module/merintr/groups.h:15-18; expansion in module/merintr/command.c:311-364 (TellGroup)` |
| message | A private message to ONE player is BP_SAY_GROUP with a one-element id list. There is no dedicated tell opcode. | `module/merintr/command.c:126-135 (`say_group = IDListAdd(NULL, player); SendSayGroup(say_group, message);`)` |
| message | Name -> id resolution for a tell happens ENTIRELY on the client, against the who-list (cinfo->current_users) built from BP_PLAYERS/BP_PLAYER_ADD. Exact case-insensitive match is tried first, then unique-prefix match. So you can tell any logged-on player anywhere on the server, not just one in your room; and you can tell nobody who is offline via this path. | `module/merintr/command.c:118-135; module/merintr/mermain.c:570-622 (FindPlayerByName, prefix match, returns INVALID_ID on tie) and mermain.c:628-644 (FindPlayerByNameExact)` |
| message | To reach a player whose name you cannot see in the who-list (e.g. a hidden DM, or an offline character), use BP_REQ_LOOKUP_NAMES(88) - it resolves against phUsers, the table of ALL characters, online or not - then feed the returned id into BP_SAY_GROUP. The stock client only uses this for mail, but nothing restricts it. | `kod/object/active/holder/nomoveon/battler/player/user.kod:4394-4441 (UserLookupNames/UserLookupEachName -> SYS FindUserByString); kod/util/system.kod:1403-1406 and system.kod:924-930` |
| message | Group tells cost 1 mana per recipient. If piMana < Length(users) the whole send is refused and nothing is delivered. | `kod/object/active/holder/nomoveon/battler/player.kod:3210-3223 (TrySayGroup: `if piMana < Length(users) { ... return FALSE } Send(self,@LoseMana,#amount=Length(users))`)` |
| message | Guild chat (SAY_GUILD) is FREE - guild sends pass no_tell=TRUE which short-circuits TrySayGroup entirely, so no mana is spent regardless of guild size. | `kod/object/active/holder/nomoveon/battler/player/user.kod:4161 and the guard at user.kod:4178-4180 (`% ... Don't do TrySayGroup on guild Sends to eliminate mana costs.` / `if no_tell OR Send(self,@TrySayGroup,...)`)` |
| message | DMs pay nothing and are never refused for group sends or broadcasts. | `kod/object/active/holder/nomoveon/battler/player/user/dm.kod:373-384 (TryBroadcast and TrySayGroup both `return TRUE`)` |
| message | Guests may only group-send to players who are currently standing in a guest room; one non-guest-room recipient kills the whole send. | `kod/object/active/holder/nomoveon/battler/player/user/guest.kod:78-94` |
| **silent** | Mana is spent and the sender's own echo BP_SAID is already transmitted BEFORE the room is asked whether the communication is allowed. So in a blocking room you lose mana, see 'You send, "..."', and the recipients get nothing. | `order of operations in kod/object/active/holder/nomoveon/battler/player/user.kod: TrySayGroup at :4180, echo AddPacket/SendPacket at :4182-4192, RoomReqCommunication at :4209-4213, delivery loop at :4215-4218` |
| message | A room may veto any communication. The generic rule is that a room under the Silence enchantment blocks everything for non-DMs. | `kod/object/active/holder/room.kod:3310-3324 (RoomReqCommunication, SID_SILENCE check)` |
| message | The room 'Out of Grace with the Higher Powers' blocks SAY_GUILD, SAY_EVERYONE and SAY_YELL outright for non-DMs, and blocks SAY_GROUP/SAY_GROUP_ONE unless EVERY recipient is a DM. | `kod/object/active/holder/room/outgrace.kod:77-105` |
| **silent** | The server does NOT require BP_SAY_GROUP recipients to be players, to be in your room, or to be logged on - only that each id resolve to a live object. Recipients who are not logged on silently drop the message (the whole SomeoneSaid body is inside `if pbLogged_on`), but you are still charged mana. | `no class/room/online check anywhere in UserSayGroup, kod/.../player/user.kod:4166-4220; recipient guard at kod/.../player/user.kod:6300 (`if pbLogged_on`); server-side validation is only GetObjectByID at blakserv/parsecli.c:291-299` |
| **silent** | An id in the list that does NOT resolve to a live object causes the ENTIRE BP_SAY_GROUP to be discarded before any kod runs. Server logs `ParseClientSendBlakod got invalid object reference N in a list`; the client is told nothing. | `blakserv/parsecli.c:291-299` |
| **silent** | A BP_USERCOMMAND sub-opcode that has no entry in usercommand_def_table (e.g. UC_GUILDINFO=11, UC_GUILD_ASK=18, UC_GUILD_LIST=22, UC_GUILD_HALLS=27, all server->client only) is discarded with a server log line and no reply. | `blakserv/parsecli.c:159-164 (`if (command_table[...].client_parms[0].type_parm == INVALID_PARM) { eprintf(...); return; }`)` |
| **silent** | A guild command sub-opcode you are not ranked for is discarded server-side after the HasGuildCommand check, with only a Debug line - no client-visible refusal. The client normally hides the UI, so this is the failure mode for a scripted agent that skips the UI. | `kod/object/active/holder/nomoveon/battler/player/user.kod:4848-4857 (`Debug("Player ",self," trying to use a guild command ",Command_num," he doesn't have!!!")`)` |
| **silent** | Guild command rank requirements, checked in this order: HasGuildCommand bitmask first, then per-command validation. RANK_APPRENTICE(1): VOTE, RENOUNCE. RANK_LORD(3): INVITE, ROSTER. RANK_LIEUTENANT(4): EXILE, SET_RANK, FORGE/END_ALLIANCE, DECLARE_ENEMY/PEACE, ABANDON_HALL. RANK_MASTER(5): DISBAND, ABDICATE. | `viRank_needed classvars: gcvote.kod:39, gcrennce.kod:42, gcinvite.kod:48, gcroster.kod:40, gcexile.kod:47, gcsetrnk.kod:41, gcally.kod:48, gcnoally.kod:39, gcenemy.kod:39, gcnoenem.kod:39, gcaband.kod:38, gcdisbnd.kod:39, gcabdic.kod:51 (all under kod/object/passive/guildcmd/); gating logic kod/object/passive/guildcmd.kod:71-89 (ResetCommand) and user.kod:4848-4850` |
| message | Founding a guild requires (a) talking to the Barloque Guildmaster NPC via BP_REQ_BUY - the UC_GUILD_ASK prompt is push-only, (b) NOT already being in a guild, (c) having PFLAG_PKILL_ENABLE set, i.e. being 'PK-enabled', and (d) enough Money in inventory. | `kod/object/active/holder/nomoveon/battler/monster/towns/barlqtwn/gcreator.kod:250-323 (GetForSale hook), specifically the PFLAG_PKILL_ENABLE gate at gcreator.kod:313-318 and `Send(who,@SendCreateGuild)` at gcreator.kod:321` |
| message | PFLAG_PKILL_ENABLE - the guild-founding prerequisite - is set automatically once base max health reaches PKILL_ENABLE_HP=30, or you are already guilded/murderer/outlaw. It is not a separate purchase. | `kod/object/active/holder/nomoveon/battler/player.kod:1047-1106 (EvaluatePKStatus); kod/include/blakston.khd:2094 `PKILL_ENABLE_HP = 30`` |
| message | Guild creation costs 5000 gold for a normal guild, 7500 for a secret one (150%). Money is checked BEFORE the name checks and subtracted only after the Guild object is successfully created. | `kod/object/active/holder/nomoveon/battler/player/user.kod:1638-1709; price source kod/util/system.kod:4235-4244 with classvars at kod/util/system.kod:243-244` |
| **silent** | Guild name must be 1..30 chars, must not duplicate an existing guild name, and must not duplicate any existing CHARACTER name. Each of the 10 rank names must be <= 20 chars. Length violations are refused with only a server-side Debug line - the client gets nothing. | `kod/object/active/holder/nomoveon/battler/player/user.kod:1662-1691; MAX_GUILD_NAME_LEN=30 and MAX_GUILD_RANK_LEN=20 at kod/include/blakston.khd:2961-2962` |
| message | A new guild must reach MINIMUM_MEMBERS=3 within THREE_PERSON_LIMIT=240 maintenance ticks or it is auto-disbanded. Guild cap is MAX_MEMBERS=400, max 2 Lieutenants. | `kod/object/passive/guild.kod:42-47 (MINIMUM_MEMBERS, THREE_PERSON_LIMIT, MAX_LIEUTENANT, MAX_MEMBERS at :23); enforcement in the MaintenanceTimer at kod/object/passive/guild.kod:619-775` |
| message | A guild becomes 'mature' (required before it may buy a guild hall) after 30 maintenance ticks, or 60 if secret. | `kod/object/passive/guild.kod:33-34 (MATURITY_NONSECRET=30, MATURITY_SECRET=60), set at guild.kod:525-530, tested by IsMature at guild.kod:592-600, gate at gcreator.kod:267-300` |
| message | Joining a guild is a two-step handshake the inviter cannot force: UC_INVITE creates a GuildInvitation item, and the invitee must BP_REQ_USE it within 2 minutes, in the same room, while unguilded and PK-enabled. Either party leaving the room destroys it. | `kod/object/passive/guildcmd/gcinvite.kod:117-118; kod/object/item/actitem/invitat.kod:16 (SELF_DELETE_DELAY=120000), :149-166 (SomethingLeft/OwnerChangedOwner), :174-190 (NewApplied checks PFLAG_PKILL_ENABLE and GetGuild()==$)` |
| message | You cannot rejoin ANY guild for 4 hours after renouncing, nor the SAME guild for 72 hours (18 x 4h). | `kod/object/passive/guild.kod:18-20 (`CANNOT_REJOIN_TIME = 4 * 60`, 'You cannot rejoin the same one for 18 times this length'); checked via CheckFormerMemberList at gcinvite.kod:103-107` |
| message | Guild membership is revealed by looking at a player - rank name plus guild name are appended to the look description - UNLESS the guild is secret. | `kod/object/active/holder/nomoveon/battler/player.kod:1672-1680 (inside ShowExtraInfo, `if poGuild <> $ AND NOT Send(poGuild,@isSecret)`)` |
| message | The OF_GUILDMATE / OF_FRIEND / OF_ENEMY flag bits are computed PER VIEWER and injected into the objectFlags field of every object payload the server sends you (and into BP_PLAYERS entries). They require BOTH parties to be guilded, and are suppressed if the target is morphed into a monster illusion. OF_FRIEND requires MUTUAL alliance; OF_ENEMY requires mutual war. | `kod/object/active/holder/nomoveon/battler/player/user.kod:2395-2424 (inside ToCliObject); flag values include/proto.h:405-407 (OF_ENEMY 0x02000000, OF_FRIEND 0x04000000, OF_GUILDMATE 0x08000000) matching kod/include/blakston.khd:128-130 (PLAYER_IS_ENEMY/FRIEND/GUILDMATE)` |
| message | Those three flags do NOTHING except draw colored rings on the automap. No combat, targeting, or friendly-fire logic reads them client-side. | `only consumers in the whole tree are clientd3d/map.c:436,442,452,461 (Ellipse with hGuildmatePen/hFriendPen/hEnemyPen)` |
| message | There is NO shared experience, NO damage-credit split, and NO shared loot. Monster treasure is generated once (scaled by the killing player's level) and dropped on the room floor as free-for-all; whoever picks it up owns it. | `kod/object/active/holder/nomoveon/battler/monster.kod:3072-3116 (Killed -> CreateTreasure(#who=killer)) and monster.kod:5016-5042 (drop loop does `Send(poOwner,@NewHold,...)` into the ROOM, with no ownership or reservation); KilledSomething on the player awards only kill counters/karma, kod/object/active/holder/nomoveon/battler/player.kod:4795-4880` |
| message | There is no formation, follow, or positional-group mechanic anywhere. Grep for 'party' in kod finds only unrelated uses; there is no leader/member relation between players. | `no party/formation class exists under kod/object/; the only inter-player relations in the tree are Guild membership (kod/object/passive/guild.kod plMembers) and the transient trade Offer` |
| message | Guild war is the one place guild affiliation changes combat consequences: killing a member of a MUTUALLY declared enemy guild skips the outlaw/murderer flagging, the karma penalty and the faction penalty; and it produces no revenant. | `kod/object/active/holder/nomoveon/battler/player.kod:3797-3813 (attack legality) and player.kod:4863-4877 (kill consequences); revenant suppression at player.kod:5050-5060 (`if Send(poGuild,@IsMutualEnemy,...) { return 0 }`)` |
| message | Guildmate/ally status raises the chance that your death spawns a revenant against your killer: base 10, +20 if same guild, +10 per direction of alliance, 0 if mutual enemies or if you die inside a Guildhall. | `kod/object/active/holder/nomoveon/battler/player.kod:5028-5072 (RevenantChance)` |
| message | Room speech between two USERS has NO distance limit. The SAY_RADIUS=50 squared-distance clip only applies to user<->monster pairs where the monster is not IsFullTalk. | `kod/object/active/holder.kod:604-627 (SayRangeCheck); kod/include/blakston.khd:1299 `SAY_RADIUS = 50`` |
| message | SAY_YELL(2) reaches every room listed in the speaker's room plYell_Zone, in addition to the speaker's own room. Recipients in a different room get a different format resource (user_yelled_nearby_str, "You hear %s yelling, ..."). | `kod/object/active/holder/room.kod:1654-1677 (SomeoneSaidRoom yell fan-out); format selection kod/object/active/holder/nomoveon/battler/player/user.kod:6424-6435` |
| message | SAY_EVERYONE(3) broadcast is server-wide, costs a percentage of max mana set by GetBroadcastManaCostPercent, and is blocked outright by PFLAG_SQUELCHED. | `kod/object/active/holder/nomoveon/battler/player.kod:3173-3208 (TryBroadcast); fan-out kod/util/system.kod:1166-1180 (SystemBroadcast loops plUsers_logged_on)` |
| **silent** | SAY_DM(9) reaching a normal player is a silent no-op: UserSay routes it into the room like normal speech, but every User's SomeoneSaid returns immediately on type==SAY_DM. On a &DM character the string is instead parsed as an admin command. | `kod/object/active/holder/nomoveon/battler/player/user.kod:4073-4076 (routed like SAY_NORMAL) and user.kod:6305-6309 (`if type = SAY_DM { return; }`); DM override at kod/object/active/holder/nomoveon/battler/player/user/dm.kod:560-566` |
| message | Guild chat requires only membership, no rank. It refuses if you have no guild, and refuses if no OTHER guild member is logged on - the message is never queued or delivered later. | `kod/object/active/holder/nomoveon/battler/player/user.kod:4133-4164 (UserSayGuild)` |
| message | The receiving client CANNOT distinguish a group tell from room speech by say_type alone in the sense of telling tell-vs-group-vs-guild apart: all three arrive as SAY_GROUP(4). It CAN distinguish them from room speech, since room speech is SAY_NORMAL(1). The finer distinction lives only in the format resource id. | `kod/object/active/holder/nomoveon/battler/player/user.kod:6459-6487 (SAY_GROUP -> user_send_str, SAY_GROUP_ONE -> user_send_one_str then `type = SAY_GROUP; % this is what the client is expecting to hear`); client only ever sees the assembled string, clientd3d/msgfiltr.c:243-257 -> DisplayServerMessage` |
| **silent** | There is no BP_RECIPIENTS opcode. HandleRecipients exists as a prototype only, with no definition and no reference anywhere in the tree. | `clientd3d/server.h:90 `bool HandleRecipients(char *ptr,long len);` - grep across all .c/.h finds no other occurrence; include/proto.h contains no BP_RECIPIENTS, only `#define SIZE_NUM_RECIPIENTS 2` at include/proto.h:513 (used by PARAM_ID_ARRAY for mail, clientd3d/protocol.c:254)` |
| **silent** | The ignore list and 'ignore all' are purely client-side; the server never learns about them. config.ignore_all suppresses ALL incoming speech including room speech; the per-user ignore list is keyed on the NAME RESOURCE, so an anonymous sender bypasses it. | `clientd3d/msgfiltr.c:243-257 (MessageSaid); anonymous name substitution at kod/object/active/holder/nomoveon/battler/player/user.kod:492-506` |
| **silent** | BP_SAY_TO and BP_SAY_GROUP are among the few opcodes NOT subject to the incoming-packet throttle, so speech and tells are never dropped as spam even at high rates. Most guild opcodes (UC_REQ_GUILDINFO, UC_INVITE, UC_VOTE, UC_MAKE_ALLIANCE/END_ALLIANCE/MAKE_ENEMY/END_ENEMY, UC_CHANGE_URL, UC_APPEAL) ARE throttled and are dropped with no message. | `throttle computed at kod/object/active/holder/nomoveon/battler/player/user.kod:874-888; BP_SAY_TO/BP_SAY_GROUP handlers at user.kod:1024-1040 have no bSpam guard, unlike e.g. user.kod:1571-1574, 1583-1586, 1619-1622, 1720-1723` |

### Constants

- `BP_SAY_TO` = 110 — `include/proto.h:118; kod/include/protocol.khd:64`
- `BP_SAY_GROUP` = 111 — `include/proto.h:119; kod/include/protocol.khd:65`
- `BP_SAID` = 206 — `include/proto.h:184; kod/include/protocol.khd:130`
- `BP_SAY_BLOCKED` = 55 — `include/proto.h:84; kod/include/protocol.khd:34`
- `BP_USERCOMMAND` = 155 — `include/proto.h:154`
- `BP_PLAYERS / BP_PLAYER_ADD / BP_PLAYER_REMOVE` = 136 / 137 / 138 — `include/proto.h:142-144`
- `BP_SEND_PLAYERS (request the who list)` = 44 — `include/proto.h:73`
- `BP_MESSAGE / BP_SYS_MESSAGE` = 32 / 31 — `include/proto.h:66-67`
- `BP_REQ_LOOKUP_NAMES / BP_LOOKUP_NAMES` = 88 / 190 — `include/proto.h:105, include/proto.h:176`
- `BP_SEND_MAIL / BP_MAIL` = 82 / 80 — `include/proto.h:98, include/proto.h:96`
- `SAY_NORMAL` = 1 — `include/proto.h:276; kod/include/blakston.khd:2179`
- `SAY_YELL` = 2 — `include/proto.h:276; kod/include/blakston.khd:2180`
- `SAY_EVERYONE` = 3 — `include/proto.h:276; kod/include/blakston.khd:2181`
- `SAY_GROUP` = 4 — `include/proto.h:276; kod/include/blakston.khd:2183`
- `SAY_RESOURCE` = 5 — `include/proto.h:276; kod/include/blakston.khd:2185`
- `SAY_EMOTE` = 6 — `include/proto.h:277; kod/include/blakston.khd:2186`
- `SAY_MESSAGE` = 7 — `include/proto.h:277; kod/include/blakston.khd:2188`
- `SAY_GROUP_ONE` = 8 - server-internal ONLY. Never on the wire in either direction; rewritten to SAY_GROUP(4) before send. It is deliberately absent from the client's SAY_* enum. — `kod/include/blakston.khd:2190; rewrite at kod/object/active/holder/nomoveon/battler/player/user.kod:6486; absent from include/proto.h:276-277`
- `SAY_DM` = 9 — `include/proto.h:277; kod/include/blakston.khd:2191`
- `SAY_GUILD` = 10 - client->server only (via BP_SAY_TO). Never appears in a server->client BP_SAID. — `include/proto.h:277; kod/include/blakston.khd:2192; consumed and replaced at kod/object/active/holder/nomoveon/battler/player/user.kod:4065-4070`
- `SIZE_ID / SIZE_LIST_LEN / SIZE_STRING_LEN / SIZE_SAY_INFO / SIZE_NUM_RECIPIENTS` = 4 / 2 / 2 / 1 / 2 — `include/proto.h:507, 509, 510, 511, 513`
- `OF_ENEMY / OF_FRIEND / OF_GUILDMATE` = 0x02000000 / 0x04000000 / 0x08000000 — `include/proto.h:405-407; kod names PLAYER_IS_ENEMY/FRIEND/GUILDMATE at kod/include/blakston.khd:128-130`
- `UC_* guild sub-opcodes` = REQ_GUILDINFO 10, GUILDINFO 11, INVITE 12, EXILE 13, RENOUNCE 14, ABDICATE 15, VOTE 16, SET_RANK 17, GUILD_ASK 18, GUILD_CREATE 19, DISBAND 20, REQ_GUILD_LIST 21, GUILD_LIST 22, MAKE_ALLIANCE 23, END_ALLIANCE 24, MAKE_ENEMY 25, END_ENEMY 26, GUILD_HALLS 27, ABANDON_GUILD_HALL 28, GUILD_RENT 29, GUILD_SET_PASSWORD 30, GUILD_SHIELD 31, GUILD_SHIELDS 32, CLAIM_SHIELD 33 — `include/proto.h:232-255; kod/include/protocol.khd:176-199`
- `GCID_* guild-command bitmask (== client GC_*)` = INVITE 0x01, EXILE 0x02, RENOUNCE 0x04, PROMOTE 0x08, DEMOTE 0x10, VOTE 0x20, ABDICATE 0x40, ROSTER 0x80, FORGE_ALLIANCE 0x100, END_ALLIANCE 0x200, DECLARE_ENEMY 0x400, PEACE 0x800, SET_RANK 0x1000, DISBAND 0x2000, ABANDON_HALL 0x4000, SET_PASSWORD 0x8000 — `kod/include/blakston.khd:2300-2315; client mirror module/merintr/guild.h:23-34 (note client omits PROMOTE/DEMOTE/ROSTER/SET_PASSWORD)`
- `RANK_APPRENTICE..RANK_MASTER` = APPRENTICE 1, SIR 2, LORD 3, LIEUTENANT 4, MASTER 5 — `kod/include/blakston.khd:2289-2293`
- `Guild succession modes` = GS_VOTING 1, GS_ASSASSINATION 2 — `kod/include/blakston.khd:2297-2298`
- `Guild founding cost` = 5000 gold normal; 7500 gold secret (viGuild_price=5000, viGuild_secret_factor=150 -> price*150/100) — `kod/util/system.kod:243-244; kod/util/system.kod:4235-4244`
- `PKILL_ENABLE_HP (guild-founding prerequisite threshold)` = 30 base max health — `kod/include/blakston.khd:2094; use at kod/object/active/holder/nomoveon/battler/player.kod:1061,1078`
- `MAX_GUILD_NAME_LEN / MAX_GUILD_RANK_LEN` = 30 / 20 — `kod/include/blakston.khd:2961-2962; client mirrors MAX_GUILD_NAME 30, MAX_RANK_LENGTH 20 at module/merintr/guild.h:16,20`
- `MAX_MEMBERS / MINIMUM_MEMBERS / MAX_LIEUTENANT` = 400 / 3 / 2 — `kod/object/passive/guild.kod:23, :45, :47; client MAX_GUILD_USERS 400 at module/merintr/guild.h:15`
- `NUM_GUILD_RANKS (rank-name pairs in UC_GUILDINFO)` = 5 pairs = 10 strings — `module/merintr/guild.h:18; kod emitter kod/object/passive/guild.kod:1195-1200`
- `CANNOT_REJOIN_TIME` = 4*60 minutes for any guild; 18x that (72h) for the same guild — `kod/object/passive/guild.kod:18-20`
- `MATURITY_NONSECRET / MATURITY_SECRET (maintenance ticks before a hall may be bought)` = 30 / 60 — `kod/object/passive/guild.kod:33-34`
- `THREE_PERSON_LIMIT` = 240 maintenance ticks to reach 3 members — `kod/object/passive/guild.kod:45`
- `WAR_LOSS_PENALTY / WAR_WINNER_PERCENT / PEACE_DELAY` = 50000 gold / 60% / 2*60*60*1000 ms — `kod/object/passive/guild.kod:29-31, :50-52`
- `Guild hall rent formula components` = RENT_BASE 5, RENT_SECRET 10, RENT_PER_MEMBER 1, RENT_PER_ALLY -2, RENT_PER_ENEMY 5, RENT_MAX_OVERDUE 480 six-minute periods — `kod/object/passive/guild.kod:37-44`
- `MAX_GROUPSIZE / MAX_NUMGROUPS / MAX_GROUPNAME (client-side named groups)` = 100 / 30 / 10 — `module/merintr/groups.h:15-18`
- `MAX_RECIPIENTS (client mail cap; server has none)` = 20 — `module/mailnews/mail.h:18`
- `INCOMING_PACKET_THROTTLE` = 5 packets per second before bSpam is set — `kod/object/active/holder/nomoveon/battler/player/user.kod:50`
- `LEN_TEMP_STRING (max said-string length, silently truncated)` = 6000 — `blakserv/bstring.h:17 -> blakserv/blakserv.h:87 LEN_MAX_CLIENT_MSG 6000; truncation at blakserv/string.c:246-248`
- `MAXSAY (client input cap)` = 512 — `clientd3d/textin.h:17`
- `SAY_RADIUS (user<->monster only)` = 50 (squared distance) — `kod/include/blakston.khd:1299; use at kod/object/active/holder.kod:622`
- `STRING_RESOURCE / NUMBER_OBJECT AddPacket widths` = 6 / 5 — `kod/include/protocol.khd:221,223; encoder blakserv/commcli.c:85-107`
- `Typed chat commands in the stock client` = say, yell, broadcast, emote, tell, tellguild, tguild, who, guild, newgroup/ngroup, addgroup/agroup, delgroup/dgroup, group — `module/merintr/merintr.c:295-345`
- `Group/tell format resources` = user_send_str "%s sends, \"%q~n\""; user_send_one_str "%s tells you, \"%q~n\""; user_send_echo_str "You send, \"%q~n\""; user_send_single_echo_str "You tell %s, \"%q~n\""; user_said_str "%s says, \"%q~n\"" — `kod/object/active/holder/nomoveon/battler/player/user.kod:95, 102, 103, 108, 109`

### What two agents can exploit or must respect

- Agents must invent their own coordination protocol. There is no server-side party, no leader, no member list, no shared XP, no shared loot, no formation. The only server-recognised collective is a Guild, and the only thing it buys you communication-wise is a free broadcast to all logged-on members.
- The cheapest reliable multicast between cooperating agents is BP_SAY_GROUP(111) with an explicit id list: one packet, one round trip, delivered to every recipient wherever they are on the map, with no proximity requirement whatsoever. Cost is exactly 1 mana per recipient (player.kod:3210-3223). Budget accordingly: a 5-agent status ping costs the sender 4 mana.
- If the agents share a guild, use BP_SAY_TO(110) with sayType=SAY_GUILD(10) instead - it is FREE (no_tell=TRUE bypasses TrySayGroup, user.kod:4161,4180) and auto-targets every logged-on member, so nobody has to maintain a roster. This is strictly better than a group tell for a fixed cooperating team. The tradeoff is that founding the guild costs 5000 gold, needs 30+ base max health, needs a trip to the Barloque Guildmaster, and needs 3 members within 240 maintenance ticks or it auto-disbands.
- On receive, ALL of {one-to-one tell, multi-recipient group send, guild send} arrive as BP_SAID with sayType==4. Do NOT try to demultiplex on sayType. Demultiplex on the 4-byte format resource id at byte offset 9 of the payload: user_send_one_str => a private tell to you alone; user_send_str => you are one of several recipients (group OR guild - these are indistinguishable). Cache those two resource ids at startup by observing a known-shape message, since the numeric values are build-dependent compiled resources.
- Because guild send and group send are wire-identical, if agents need to distinguish channels they MUST embed an in-band tag in the message text (e.g. a leading sigil). The protocol will not do it for them.
- Sender identity: the BP_SAID senderObjId (bytes 1-4) is authoritative and stable; the senderNameRsc (bytes 5-8) is NOT trustworthy for identity, because PFLAG_ANONYMOUS replaces it with the shared literal "Someone" resource (user.kod:492-506) while leaving senderObjId intact. Key your peer table on object id.
- Maintain a persistent nameRsc -> string map from BP_PLAYERS(136) and BP_PLAYER_ADD(137). Without it, every BP_SAID senderNameRsc is an unresolvable integer and %s expansion inside format resources will fail. Refresh with BP_SEND_PLAYERS(44), which takes no payload.
- Free presence signalling for guildmates: on any guildmate login the server pushes a BP_MESSAGE with resource user_guildmate_logon ("~IHail your guildmate %s!") and on logoff user_guildmate_logoff, before/after the BP_PLAYER_ADD/REMOVE (user.kod:813-817, 838-843). A guilded agent team gets roster presence for free without polling.
- BP_REQ_LOOKUP_NAMES(88) is the escape hatch when you need an object id for a character not in your who-list: it resolves against ALL characters ever created, online or not, and returns 0 for misses. Send expectedCount equal to the number of comma-separated tokens or the reply desynchronises. The literal token "guild" resolves to your own guild's object id, which is the addressing trick for guild-wide mail.
- Mail (BP_SEND_MAIL=82) is the ONLY store-and-forward channel: it reaches offline characters, costs nothing, and addressing it to the guild object id fans out to every member including offline ones (guild.kod:1081-1095). Use it for durable handoffs; use tells for live coordination.
- Telling an OFFLINE player wastes 1 mana and produces no error: the recipient's SomeoneSaid body is entirely inside `if pbLogged_on` (user.kod:6300). Always confirm the target is in your who-list before spending mana.
- Two silent-failure traps to defend against, both producing zero server->client output: (1) any unresolvable object id anywhere in the BP_SAY_GROUP list discards the ENTIRE message (parsecli.c:291-299) - never reuse ids across a resync or after BP_INVALIDATE_DATA; (2) a guild sub-opcode you lack the rank bit for is discarded after HasGuildCommand with only a server Debug line (user.kod:4848-4857) - read guildCommandFlags out of UC_GUILDINFO and gate locally rather than probing.
- Room vetoes burn resources before they take effect. In UserSayGroup the mana is spent (:4180) and your own echo BP_SAID is already flushed (:4192) before RoomReqCommunication is consulted (:4209). So 'I saw my own echo' is NOT proof of delivery. If delivery confirmation matters, require an explicit ack from each peer.
- One room actually enforces this: OutOfGrace blocks SAY_GUILD/SAY_EVERYONE/SAY_YELL outright and blocks group sends unless every recipient is a DM (outgrace.kod:77-105). Any room under the Silence enchantment blocks all communication for non-DMs (room.kod:3310-3324). An agent that loses contact should suspect its own room before suspecting the peer.
- BP_SAY_TO and BP_SAY_GROUP are NOT rate-limited (no bSpam guard at user.kod:1024-1040), so a high-frequency coordination channel is viable. But the guild administration opcodes (UC_REQ_GUILDINFO, UC_INVITE, UC_VOTE, UC_MAKE_ALLIANCE/END_ALLIANCE/MAKE_ENEMY/END_ENEMY) ARE gated at 5 packets/second and are dropped silently, so batch or space guild admin.
- In-room speech between users has NO distance clip (holder.kod:604-627), so SAY_NORMAL(1) is a perfectly good zero-cost broadcast to every agent in the same room - cheaper than a group tell whenever the team is co-located. The 50-unit SAY_RADIUS only gates user<->monster.
- Loot after a cooperative kill is an uncontested race on the room floor (monster.kod:5016-5040). If agents must split loot, they need an application-level claim protocol; the server offers nothing, and the killing blow confers no ownership - it only scales treasure generation.
- Do not send BP_SAY_BLOCKED(55); its handler is an empty stub (user.kod:3754-3759). Conversely, do not rely on the ignore list to shield an agent - it is client-side only, and an anonymous sender bypasses it entirely since it keys on the name resource.
- kod's view of a wire id list is REVERSED (parsecli.c:283-285). If order matters - notably which recipient becomes First(users) for the hidden-DM warning at user.kod:4194-4201, and which name appears in your own 'You tell X' echo - put the semantically-first recipient LAST on the wire.
- Mutual guild war is the only mechanical opt-in to consequence-free PvP between agent teams: it removes murderer/outlaw flagging, the karma hit, and faction loss (player.kod:3797-3813, 4863-4877), and suppresses revenants (player.kod:5050-5060). Both guilds must declare via UC_MAKE_ENEMY(25); one-sided declarations do nothing. Backing out costs 50000 gold and is locked for 2 hours.
- Guild affiliation is publicly discoverable: any player can look at another and read rank + guild name (player.kod:1672-1680), and guild shields name their owner (guilshld.kod:216-224) - UNLESS the guild is secret, which costs 50% more (7500 vs 5000) and doubles the maturity wait (60 vs 30 ticks). Choose secret if the agent team's affiliation should not be inferable by observers.
- Recruiting an agent into a guild is a two-party, same-room, 2-minute handshake: UC_INVITE(12) then the invitee BP_REQ_USE(106) on the invitation item id. It dies if either party leaves the room or the inviter logs off (invitat.kod:149-166, 93-98). Script both agents to hold position for the duration. The invitee must be unguilded and PK-enabled, and must not have renounced a guild in the last 4 hours.

### Not determined

- I could not find any BP_RECIPIENTS opcode. I searched include/proto.h (the full enum at lines 40-262), kod/include/protocol.khd, and grepped 'RECIPIENT' across include/, clientd3d/, blakserv/ and module/. The only hits are `#define SIZE_NUM_RECIPIENTS 2` (include/proto.h:513, used by PARAM_ID_ARRAY for mail) and the mail module's MAX_RECIPIENTS. HandleRecipients has a prototype at clientd3d/server.h:90 and no definition or caller anywhere. I did NOT check git history to see whether the opcode existed in an earlier revision, so I cannot say whether it was removed or never implemented - only that nothing in the current tree sends, parses, or numbers it.
- BP_SAY_GROUP performs no class check on its recipients, so it appears possible to target a Monster/NPC object id and trigger its MOB_LISTEN library/quest response handler (monster.kod:2581-2650) from a DIFFERENT room, since no proximity check exists in UserSayGroup. I verified the absence of the checks by reading the code but did not trace whether the NPC's reply actually reaches a remote speaker (most replies go via Send(poOwner,@SomeoneSaid,...) into the NPC's own room, which the speaker would not hear; a few go via Send(what,@SomeoneSaid,...) directly to the speaker). Treat this as unverified. Confirming it would need a live server, which the task forbids.
- I did not determine whether Blakod's `vrName = name` assignment inside User.Constructor (user.kod:363-367) creates a per-instance shadow of the classvar or mutates the class. Empirically it must be per-instance (every user has a distinct name resource, and ToCliPlayers sends a distinct rName per user at user.kod:2530), and the echo path uses vrName directly at user.kod:4182, but I did not read the kod compiler or blakserv/object.c to confirm the mechanism.
- I did not determine the guild MaintenanceTimer period in wall-clock time. GetMaintenanceDelay returns piMaintenance_delay (kod/util/system.kod:4246-4249), whose initial value I did not chase, so I cannot convert the tick-denominated constants (MATURITY_NONSECRET=30, THREE_PERSON_LIMIT=240, RENT_MAX_OVERDUE=480) into hours.
- I did not exhaustively verify that no other room class overrides RoomReqCommunication. Grep found exactly two implementations (kod/object/active/holder/room.kod:3310 and kod/object/active/holder/room/ghall/../room/outgrace.kod:77), but a room could also veto indirectly (e.g. by enchanting itself with SID_SILENCE), and I did not enumerate what applies that enchantment.
- I did not read the guild-hall room classes (kod/object/active/holder/room/ghall/guildh1..15.kod) to determine whether a guild hall provides shared storage, a shared treasury accessible to members, or member-only access gating. So the full list of mechanical guild benefits beyond chat/identity/war-legality/revenant-chance/heraldry may be incomplete on the guild-hall side.
- I did not verify the UC_VOTE tally rules (guild.kod CountVotes at :637) or what GS_ASSASSINATION succession requires, so I cannot say precisely how guild leadership changes hands beyond 'votes are counted on the maintenance tick, not immediately'.
- I did not confirm whether the kod engine tolerates the extra `#users=users` keyword that UserSayGroup passes to RoomReqCommunication (user.kod:4209) when the base Room handler (room.kod:3310) does not declare a `users` parameter. The OutOfGrace override does declare it, and the pattern appears throughout the codebase, so I assume extra named parameters are ignored - but I did not read the interpreter's parameter-binding code to prove it.


---

## Adversarial verification

Each format below was re-checked against the source by a second agent told to default
to refuted. The run was cut short, so absence from this table means unchecked, not wrong.

| opcode | verdict | note |
|---|---|---|
| BP_OFFER_CANCELED (212), server->client | confirmed | Checks performed:  1. Citation content — yes. 5258 is inside `OfferCanceled()`, 5269 inside `CancelIfOffer()`, 5356 inside `UserCounterOffer()`'s CounterOffer-failure branch, 5650 at the end of `Accep |
| BP_ACCEPT_OFFER (121), client->server | confirmed | Every element of the claim checks out against the source.  1. Citation contents: sprocket.c:52 is exactly the BP_ACCEPT_OFFER row and it is `{{0, DONE_PARM}}` — a zero-field entry. clientd3d/protocol. |
| BP_COUNTEROFFER (214), server->client | confirmed | CONFIRMED. I went to every cited line and the citations are unusually accurate — user.kod:5374-5379 contains exactly the AddPacket(1,BP_COUNTEROFFER,2,Length(item_list)) plus the per-item ToCliObject  |
| BP_OFFER (211), server->client | confirmed | The layout is correct as claimed, field for field, including the conditional and variable-length parts. I checked all six axes.  1. Citations are real. user.kod:5197-5206 contains exactly the quoted s |
| BP_OFFERED (213), server->client | confirmed | I tried to refute this and could not. Every element of the claimed layout is confirmed on both sides.  1. Citations contain what is claimed. user.kod:4993 is literally `AddPacket(1,BP_OFFERED,2,Length |
| BP_REQ_OFFER (120), client->server | confirmed | Every load-bearing element of the claim holds: opcode 120 agrees in include/proto.h:128 and kod/include/protocol.khd:74; sprocket.c:48 is verbatim as quoted; the client writer at protocol.c:50/210-214 |
| BP_CANCEL_OFFER (122), client->server | confirmed | Every element of the claim was verified at the cited lines and cross-checked against the independent server parser and client emitter.  1. Citations are real and say what is claimed. sprocket.c:50 is  |
| BP_REQ_COUNTEROFFER (123), client->server | confirmed | Every element of the claim checks out against the source; I could not refute any part of it. Details, with citations.  1) OPCODE NUMBER — correct.   include/proto.h:131  "BP_REQ_COUNTEROFFER      = 12 |
| BP_OBJECT_CONTENTS (135), server->client | incomplete | Every byte-level assertion in the claim checks out. I could not refute a single field width, condition, or ordering claim. Two things are missing/misstated, neither of which changes the byte layout bu |
| BP_REQ_GET (113), client->server | confirmed | Every load-bearing element of the claim checks out against the source; only two secondary details in the "notes" prose are inaccurate, and one citation range is off by ~5 lines. The layout itself (5 b |
| BP_REQ_GET_FROM_CONTAINER (239), client->server | incomplete | Every cited file:line contains exactly what is claimed, and the byte layout is correct. Verified item by item:  1. OPCODE — CONFIRMED both sides. `include/proto.h:217` reads `BP_REQ_GET_FROM_CONTAINER |
| BP_REQ_DROP (118), client->server | confirmed | CONFIRMED on every point that can desynchronise a stream. Opcode 118 agrees in both include/proto.h:126 and kod/include/protocol.khd:72. Widths: opcode 1, count 2 (SIZE_LIST_LEN, include/proto.h:509), |
| BP_REQ_PUT (112), client->server | incomplete | The claimed layout is substantively right and I could not refute the parts it states: opcode 112 matches in both include/proto.h:120 and kod/include/protocol.khd:66; BP_REQ_PUT is a main opcode in cli |
| BP_SEND_OBJECT_CONTENTS (43), client->server | incomplete | Every cited line exists and says what is claimed, and the opcode number is right in both headers. The bytes the stock client emits are correct. But the layout is stated as unconditionally 4 bytes of i |
| BP_REMOVE (218), server->client | confirmed | Every load-bearing element of the claim checks out, and the layout is exact.  1. Citation contains what is claimed: yes. user.kod:6152 is literally "AddPacket(1,BP_REMOVE,4,what);" inside SomethingLef |
| BP_REQ_LOOK (116), client->server | confirmed | The claimed client->server format is exactly right and I could confirm every byte of it from three independent places.  1. Citation contains what is claimed. user.kod:1042 is literally "if liClient_cm |
| BP_REQ_ATTACK (103), client->server | incomplete | 1. Citation check -- HOLDS. kod/object/active/holder/nomoveon/battler/player/user.kod:1104 is exactly `if liClient_cmd = BP_REQ_ATTACK`, and :1111-1113 are      iAttack_type = Nth(client_msg,2);     o |
| BP_REMOVE (218), server->client | confirmed | 1) Citation content: the cited range does contain SomethingLeft, though the method header is at line 6141 (not 6139) and the body ends at 6157; the single AddPacket is at 6152. The claim's range is cl |
| BP_CREATE (217), server->client | wrong | The opcode number, the send site, the coordinate arithmetic, the widths, and the trailing SendMoveAnimation/SendMoveOverlays block all check out. But the layout is MISSING an entire palette-translatio |
| BP_CREATE (217), server->client | incomplete | CITATION CHECK - `include/proto.h:191` is WRONG: that line is `BP_OFFERED = 213,`. `BP_CREATE = 217` is at `include/proto.h:195`. The VALUE 217 is right and agrees with `kod/include/protocol.khd:141   |
| BP_MESSAGE (32), server->client | wrong | The header is right and the citations exist, but the claim states two encoding rules that are affirmatively FALSE, either of which silently desynchronises the stream, plus it omits four properties of  |
| BP_MOVE (200), server->client | wrong | 1) Does the citation contain what is claimed? Substantially yes, though the line range is slightly off. SomethingMoved is at user.kod:6159 and BuildPacketSomethingMoved at :6185; the claimed 6173-6191 |
| BP_MESSAGE (32), server->client | incomplete | CITATION CHECK — all three cited lines contain what is claimed.  1. `include/proto.h:67` → `   BP_MESSAGE               = 32,` — CONFIRMED. 2. `kod/include/protocol.khd:18` → `   BP_MESSAGE            |
| BP_TURN (201), server->client | confirmed | 1. Citation is accurate. user.kod:6209 is literally `AddPacket(1,BP_TURN,4,what,2,new_angle);` inside `SomethingTurned` (:6195), with `SendPacket(poSession)` on the next line. The cited range 6209-621 |
| BP_CREATE (217), server->client | wrong | The citation is real and the opcode is right, but the field ORDER is wrong and a conditional field is mislabelled as unconditional.  1. Citation check: PASS. user.kod:6113 is `SomethingEntered(what =  |
