# Data Track - Invite Campaign

Target Date: March 25, 2026
Person / Responsable : Thales Barbosa, Laurence, H R
Phase: Phase 3: Reserve Launch
Status: In progress
Type: Task

**What is the invite Campaign?**

We are running an invite campaign on XDC to grow the User base on the chain after the deployment of the GoodDollar Reserve on XDC. 

**Campaign Mechanisms**

We have two mechanisms for the campaign:

The invite campaign is only available through the GoodWallet.👉 *During the campaign, only XDC should be shown (hide Celo).*

1. **Referral invites (user → user, invite link)**
    - Existing user shares an invite link
    - New user joins and claims G$ on **XDC** using the link
    
    **Reward logic:** 
    
    - 500 G$ → invited user
    - 1000 G$ → inviter
    - Total cost per referral: 1500 G$
    - Rewards distributed after: 3 claims on XDC and wait minim 7 days. Needs to be claimed, When they claim it (pop ups), **both of you receive the reward**
2. GOODXDC invite code (no referrer required). An user sees the code through a Social media post for example, joins add the code and get the reward. 
    - User enters campaign code
    - Reward logic: 
    500 G$ → invited user
    1000 G$ → returned to campaign pool (controlled by protocol)
    - Rewards distributed after: 3 claims on XDC and wait minim 7 days. Then you can claim it (pop ups)
    - No inviter required

## Data needed to track

# 🎯 Goals → Data needed to track

*(Invite Campaign – XDC)*

We want to measure:

- **Acquisition** → how many users we bring in
- **Budget** → how much G$ we distribute
- **Activation funnel** → do users reach 3 claims + reward
- **Behavior / UX** → where users drop before completing
- (Optional) **Inviter performance** → who is driving growth

---

## 1. Acquisition

*How many users we acquire and through which mechanism*

**Data needed**

- users via referral
- users via campaign code

Per user:

- wallet
- invite_type (referral / campaign_code)
- campaign code (if applicable)
- inviter (if referral)

## 2. Budget

*How much we spend and how much is left*

**Data needed:**

- Total G$ distributed via campaign codes
- Total G$ distributed to invitees
- Total G$ distributed to inviters
- Total G$ returned to campaign pool
- Remaining campaign balance

 Make sure  the contract doesn’t run out of funds

## 3. Activation funnel

*How users move from onboarding → 3 claims → reward*

**Data needed:**

- users who:
    - complete 1st claim
    - complete 2nd claim
    - complete 3rd claim
    - become reward eligible
    - claim reward

This shows:

- how many users actually convert
- where we lose users after onboarding

---

## 4. Behavior / UX (in-app, not on-chain)

*What users try to do but don’t complete*

### Entry → conversion

- users who visit the invite / claim page
- users who start the flow
- users who complete it

page view → completion conversion

### Invite mechanism usage

- users who:
    - enter a campaign code
    - come via invite link

(Not available on-chain)

### Failures / errors

Understand what fails before hitting the blockchain

- users who:
    - fail to generate invite link
    - enter invalid code
    - fail to complete claim
    - drop before completing

Include basic error types:

- invalid_code
- duplicate / already used
- transaction rejected
- other

---

## 5. Inviter performance (optional/last layer)

*Who is driving growth*

**Data needed:**

- invites per inviter
- successful invited users per inviter

## ⚠️ Key clarification

- **On-chain / backend data** → acquisition, budget,
- **In-app analytics** → behavior, drop-offs, errors, funnel

 Both are required to understand the full funnel.

---

# 💬 In simple terms

We want to understand:

1. Did users come? (acquisition)
2. How much did we pay? (budget) 
3. Did they stick? (3 claims + reward)
4. Where do we lose them? (UX / funnel)
5. Who is driving growth? is there a super inviter? Possibly farming 

- Inviter Flow
    
    
    | Invite Rewards Tab(Invite_Rewards_Tab_Selected)<no properties> | <back> |  |  |  |  |  |  |
    | --- | --- | --- | --- | --- | --- | --- | --- |
    |  | How it works(no event) | <back> |  |  |  |  |  |
    |  | Join button(no event) | Failed to join(Invite_Rewards_Join_Failed)<chainID = 50>, <reason> | <back> |  |  |  |  |
    |  |  | Joined Successfully+ invite code created(Invite_Rewards_Join_Succeeded)<chainID = 50>, <rewardAmount> | Share(no event) | <back> |  |  |  |
    |  |  |  | Copy Link(no event) | <back> |  |  |  |
    |  |  |  | Wait for invitee to become eligiblefor invite rewards(3x claim + 7 days) | Invitee not eligible yet |  |  |  |
    |  |  |  |  | Invitee eligible<canCollect> | Invitee claims their invite reward(GoodDollar_Claim_Succeeded)<chainID = 50>, <amount = 500>, <subtype =  invite> | Inviter claims their invite reward(GoodDollar_Claim_Succeeded)<chainID = 50>, <amount = 1000>, <subtype =  invite> | <end> |
- Invitee Flow
    
    
    | New user comes in | **Signup Funnel** |  |  |  |  |  |  |
    | --- | --- | --- | --- | --- | --- | --- | --- |
    |  | (goto_Signup) |  |  |  |  |  |  |
    |  | (signup_Started)<chainID = 50>, <provider>, <source> |  |  |  |  |  |  |
    |  | (signup_Success)<chainID = 50>, <inviteCode> | **FV Funnel** |  |  |  |  |  |
    |  |  | (FV_INTRO)<reverify> |  |  |  |  |  |
    |  |  | (FV_START)<no properties> |  |  |  |  |  |
    |  |  | (FV_GETREADYZOOM)<no properties> |  |  |  |  |  |
    |  |  | (FV_PROGRESSZOOM)<no properties> |  |  |  |  |  |
    |  |  | (FV_SUCCESSZOOM)<no properties> | Invitee eligible for claiming | 3x claim+ 7 days | Invitee eligible for invite rewards<canCollect> | 4th claim: Invitee claims their invite reward(GoodDollar_Claim_Succeeded)<chainID = 50>, <amount = 500>, <subtype =  invite> | <end> |