import assert from 'assert'
import { BigNumber, ethers } from 'ethers'

import Unirep from "../artifacts/contracts/Unirep.sol/Unirep.json"
import { numAttestationsPerEpochKey } from '../config/testLocal'
import { Attestation, IEpochTreeLeaf, UnirepState } from './UnirepState'
import { IUserStateLeaf, UserState } from './UserState'
import { hash5, hashLeftRight } from 'maci-crypto'
import { computeEmptyUserStateRoot } from '../test/utils'
import { id } from 'ethers/lib/utils'
import comment from '../database/models/comment'
import { DEFAULT_AIRDROPPED_KARMA } from '../config/socialMedia'

/*
 * Retrieves and parses on-chain Unirep contract data to create an off-chain
 * representation as a UnirepState object.
 * @param provider An Ethereum provider
 * @param address The address of the Unirep contract
 * @param startBlock The block number when Unirep contract is deployed
 */
const genUnirepStateFromContract = async (
    provider: ethers.providers.Provider,
    address: string,
    startBlock: number,
) => {

    const unirepContract = new ethers.Contract(
        address,
        Unirep.abi,
        provider,
    )

    const treeDepths_ = await unirepContract.treeDepths()
    const globalStateTreeDepth = treeDepths_.globalStateTreeDepth
    const userStateTreeDepth = treeDepths_.userStateTreeDepth
    const epochTreeDepth = treeDepths_.epochTreeDepth
    const nullifierTreeDepth = treeDepths_.nullifierTreeDepth
    const attestingFee = await unirepContract.attestingFee()
    const epochLength = await unirepContract.epochLength()
    const numEpochKeyNoncePerEpoch = await unirepContract.numEpochKeyNoncePerEpoch()

    const unirepState = new UnirepState(
        ethers.BigNumber.from(globalStateTreeDepth).toNumber(),
        ethers.BigNumber.from(userStateTreeDepth).toNumber(),
        ethers.BigNumber.from(epochTreeDepth).toNumber(),
        ethers.BigNumber.from(nullifierTreeDepth).toNumber(),
        attestingFee,
        ethers.BigNumber.from(epochLength).toNumber(),
        ethers.BigNumber.from(numEpochKeyNoncePerEpoch).toNumber(),
        numAttestationsPerEpochKey,
    )

    const newGSTLeafInsertedFilter = unirepContract.filters.NewGSTLeafInserted()
    const newGSTLeafInsertedEvents =  await unirepContract.queryFilter(newGSTLeafInsertedFilter, startBlock)

    const attestationSubmittedFilter = unirepContract.filters.AttestationSubmitted()
    const attestationSubmittedEvents =  await unirepContract.queryFilter(attestationSubmittedFilter, startBlock)

    const postSubmittedFilter = unirepContract.filters.PostSubmitted()
    const postSubmittedEvents =  await unirepContract.queryFilter(postSubmittedFilter, startBlock)

    const commentSubmittedFilter = unirepContract.filters.CommentSubmitted()
    const commentSubmittedEvents =  await unirepContract.queryFilter(commentSubmittedFilter, startBlock)

    const reputationSubmittedFilter = unirepContract.filters.ReputationNullifierSubmitted()
    const reputationSubmittedEvents =  await unirepContract.queryFilter(reputationSubmittedFilter, startBlock)

    const epochEndedFilter = unirepContract.filters.EpochEnded()
    const epochEndedEvents =  await unirepContract.queryFilter(epochEndedFilter, startBlock)

    const userStateTransitionedFilter = unirepContract.filters.UserStateTransitioned()
    const userStateTransitionedEvents =  await unirepContract.queryFilter(userStateTransitionedFilter, startBlock)

    const sequencerFilter = unirepContract.filters.Sequencer()
    const sequencerEvents =  await unirepContract.queryFilter(sequencerFilter, startBlock)

    // Reverse the events so pop() can start from the first event
    newGSTLeafInsertedEvents.reverse()
    attestationSubmittedEvents.reverse()
    postSubmittedEvents.reverse()
    commentSubmittedEvents.reverse()
    reputationSubmittedEvents.reverse()
    epochEndedEvents.reverse()
    userStateTransitionedEvents.reverse()
    for (let i = 0; i < sequencerEvents.length; i++) {
        const sequencerEvent = sequencerEvents[i]
        const occurredEvent = sequencerEvent.args?._event
        if (occurredEvent === "UserSignUp") {
            const newLeafEvent = newGSTLeafInsertedEvents.pop()
            assert(newLeafEvent !== undefined, `Event sequence mismatch: missing newGSTLeafInsertedEvent`)

            const newLeaf = newLeafEvent.args?._hashedLeaf
            unirepState.signUp(unirepState.currentEpoch, BigInt(newLeaf))
        } else if (occurredEvent === "AttestationSubmitted") {
            const attestationEvent = attestationSubmittedEvents.pop()
            assert(attestationEvent !== undefined, `Event sequence mismatch: missing attestationSubmittedEvent`)
            const epoch = attestationEvent.args?._epoch.toNumber()
            assert(
                epoch === unirepState.currentEpoch,
                `Attestation epoch (${epoch}) does not match current epoch (${unirepState.currentEpoch})`
            )

            const _attestation = attestationEvent.args?.attestation
            const attestation = new Attestation(
                BigInt(_attestation.attesterId),
                BigInt(_attestation.posRep),
                BigInt(_attestation.negRep),
                BigInt(_attestation.graffiti),
                _attestation.overwriteGraffiti
            )
            unirepState.addAttestation(attestationEvent.args?._epochKey.toString(), attestation)
        } else if (occurredEvent === "PostSubmitted") {
            const postEvent = postSubmittedEvents.pop()
            assert(postEvent !== undefined, `Event sequence mismatch: missing postSubmittedEvent`)
            const epoch = postEvent.args?._epoch.toNumber()
            assert(
                epoch === unirepState.currentEpoch,
                `Post epoch (${epoch}) does not match current epoch (${unirepState.currentEpoch})`
            )
        } else if (occurredEvent === "CommentSubmitted") {
            const commentEvent = commentSubmittedEvents.pop()
            assert(commentEvent !== undefined, `Event sequence mismatch: missing commentSubmittedEvent`)
            const epoch = commentEvent.args?._epoch.toNumber()
            assert(
                epoch === unirepState.currentEpoch,
                `Comment epoch (${epoch}) does not match current epoch (${unirepState.currentEpoch})`
            )
        } else if (occurredEvent === "ReputationNullifierSubmitted") {
            const reputationEvent = reputationSubmittedEvents.pop()
            assert(reputationEvent !== undefined, `Event sequence mismatch: missing ReputationNullifierSubmitted`)
            unirepState.addKarmaNullifiers(reputationEvent.args?.karmaNullifiers.map((n) => BigInt(n)))
        } else if (occurredEvent === "EpochEnded") {
            const epochEndedEvent = epochEndedEvents.pop()
            assert(epochEndedEvent !== undefined, `Event sequence mismatch: missing epochEndedEvent`)
            const epoch = epochEndedEvent.args?._epoch.toNumber()
            assert(
                epoch === unirepState.currentEpoch,
                `Ended epoch (${epoch}) does not match current epoch (${unirepState.currentEpoch})`
            )

            // Get epoch tree leaves of the ending epoch
            let [epochKeys_, epochKeyHashchains_] = await unirepContract.getEpochTreeLeaves(epoch)
            epochKeys_ = epochKeys_.map((epk) => BigInt(epk.toString()))
            epochKeyHashchains_ = epochKeyHashchains_.map((hc) => BigInt(hc.toString()))
            const epochTreeLeaves: IEpochTreeLeaf[] = []
            for (let i = 0; i < epochKeys_.length; i++) {
                const epochTreeLeaf: IEpochTreeLeaf = {
                    epochKey: epochKeys_[i],
                    hashchainResult: epochKeyHashchains_[i]
                }
                epochTreeLeaves.push(epochTreeLeaf)
            }

            unirepState.epochTransition(epoch, epochTreeLeaves)
        } else if (occurredEvent === "UserStateTransitioned") {
            // const newLeafEvent = newGSTLeafInsertedEvents.pop()
            // assert(newLeafEvent !== undefined, `Event sequence mismatch: missing newGSTLeafInsertedEvent`)
            const userStateTransitionedEvent = userStateTransitionedEvents.pop()
            assert(userStateTransitionedEvent !== undefined, `Event sequence mismatch: missing userStateTransitionedEvent`)

            const newLeaf = userStateTransitionedEvent.args?.userTransitionedData.newGlobalStateTreeLeaf

            const isProofValid = await unirepContract.verifyUserStateTransition(
                newLeaf,
                userStateTransitionedEvent.args?.userTransitionedData.attestationNullifiers,
                userStateTransitionedEvent.args?.userTransitionedData.epkNullifiers,
                userStateTransitionedEvent.args?.userTransitionedData.fromEpoch,
                userStateTransitionedEvent.args?.userTransitionedData.fromGlobalStateTree,
                userStateTransitionedEvent.args?.userTransitionedData.fromEpochTree,
                userStateTransitionedEvent.args?.userTransitionedData.proof,
            )
            // Proof is invalid, skip this step
            if (!isProofValid) {
                console.log("Invalid UserStateTransitioned proof")
                continue
            }

            const attestationNullifiers = userStateTransitionedEvent.args?.userTransitionedData.attestationNullifiers.map((n) => BigInt(n))
            const epkNullifiers = userStateTransitionedEvent.args?.userTransitionedData.epkNullifiers.map((n) => BigInt(n))
            // Combine nullifiers and mod them
            const allNullifiers = attestationNullifiers.concat(epkNullifiers).map((nullifier) => BigInt(nullifier) % BigInt(2 ** unirepState.nullifierTreeDepth))

            unirepState.userStateTransition(unirepState.currentEpoch, BigInt(newLeaf), allNullifiers)
        } else {
            throw new Error(`Unexpected event: ${occurredEvent}`)
        }
    }
    assert(newGSTLeafInsertedEvents.length == 0, `${newGSTLeafInsertedEvents.length} newGSTLeafInsert events left unprocessed`)
    assert(attestationSubmittedEvents.length == 0, `${attestationSubmittedEvents.length} attestationSubmitted events left unprocessed`)
    assert(epochEndedEvents.length == 0, `${epochEndedEvents.length} newGSTLeafInsert events left unprocessed`)
    assert(userStateTransitionedEvents.length == 0, `${userStateTransitionedEvents.length} newGSTLeafInsert events left unprocessed`)
    return unirepState
}

/*
 * Create UserState object from given user state and
 * retrieves and parses on-chain Unirep contract data to create an off-chain
 * representation as a UserState object (including UnirepState object).
 * (This assumes user has already signed up in the Unirep contract)
 * @param provider An Ethereum provider
 * @param address The address of the Unirep contract
 * @param startBlock The block number when Unirep contract is deployed
 * @param userIdentity The semaphore identity of the user
 * @param userIdentityCommitment Commitment of the userIdentity
 * @param latestTransitionedEpoch Latest epoch user has transitioned to
 * @param latestGSTLeafIndex Leaf index in the global state tree of the latest epoch user has transitioned to
 * @param latestUserStateLeaves User state leaves (empty if no attestations received)
 * @param latestEpochKeys User's epoch keys of the epoch user has transitioned to
 */
const genUserStateFromParams = async (
    provider: ethers.providers.Provider,
    address: string,
    startBlock: number,
    userIdentity: any,
    userIdentityCommitment: any,
    transitionedPosRep: number,
    transitionedNegRep: number,
    currentEpochPosRep: number,
    currentEpochNegRep: number,
    latestTransitionedEpoch: number,
    latestGSTLeafIndex: number,
    latestUserStateLeaves?: IUserStateLeaf[],
) => {
    const unirepState = await genUnirepStateFromContract(
        provider,
        address,
        startBlock,
    )
    const userState = new UserState(
        unirepState,
        userIdentity,
        userIdentityCommitment,
        true,
        transitionedPosRep,
        transitionedNegRep,
        currentEpochPosRep,
        currentEpochNegRep,
        latestTransitionedEpoch,
        latestGSTLeafIndex,
        latestUserStateLeaves,
    )
    return userState
}

/*
 * This function works mostly the same as genUnirepStateFromContract,
 * except that it also updates the user's state during events processing.
 * @param provider An Ethereum provider
 * @param address The address of the Unirep contract
 * @param startBlock The block number when Unirep contract is deployed
 * @param userIdentity The semaphore identity of the user
 * @param userIdentityCommitment Commitment of the userIdentity
 */
const _genUserStateFromContract = async (
    provider: ethers.providers.Provider,
    address: string,
    startBlock: number,
    userIdentity: any,
    userIdentityCommitment: any,
) => {

    const unirepContract = new ethers.Contract(
        address,
        Unirep.abi,
        provider,
    )

    const treeDepths_ = await unirepContract.treeDepths()
    const globalStateTreeDepth = treeDepths_.globalStateTreeDepth
    const userStateTreeDepth = treeDepths_.userStateTreeDepth
    const epochTreeDepth = treeDepths_.epochTreeDepth
    const nullifierTreeDepth = treeDepths_.nullifierTreeDepth
    const attestingFee = await unirepContract.attestingFee()
    const epochLength = await unirepContract.epochLength()
    const numEpochKeyNoncePerEpoch = await unirepContract.numEpochKeyNoncePerEpoch()
    const numAttestationsPerEpochKey = await unirepContract.numAttestationsPerEpochKey()

    const unirepState = new UnirepState(
        ethers.BigNumber.from(globalStateTreeDepth).toNumber(),
        ethers.BigNumber.from(userStateTreeDepth).toNumber(),
        ethers.BigNumber.from(epochTreeDepth).toNumber(),
        ethers.BigNumber.from(nullifierTreeDepth).toNumber(),
        attestingFee,
        ethers.BigNumber.from(epochLength).toNumber(),
        ethers.BigNumber.from(numEpochKeyNoncePerEpoch).toNumber(),
        ethers.BigNumber.from(numAttestationsPerEpochKey).toNumber(),
    )

    const userState = new UserState(
        unirepState,
        userIdentity,
        userIdentityCommitment,
        false,
    )
    const emptyUserStateRoot = computeEmptyUserStateRoot(unirepState.userStateTreeDepth)
    const userDefaultGSTLeaf = hash5([
        userIdentityCommitment,
        emptyUserStateRoot,
        BigInt(DEFAULT_AIRDROPPED_KARMA),
        BigInt(0),
        BigInt(0)
    ])

    const newGSTLeafInsertedFilter = unirepContract.filters.NewGSTLeafInserted()
    const newGSTLeafInsertedEvents =  await unirepContract.queryFilter(newGSTLeafInsertedFilter, startBlock)

    const attestationSubmittedFilter = unirepContract.filters.AttestationSubmitted()
    const attestationSubmittedEvents =  await unirepContract.queryFilter(attestationSubmittedFilter, startBlock)

    const postSubmittedFilter = unirepContract.filters.PostSubmitted()
    const postSubmittedEvents =  await unirepContract.queryFilter(postSubmittedFilter, startBlock)

    const commentSubmittedFilter = unirepContract.filters.CommentSubmitted()
    const commentSubmittedEvents =  await unirepContract.queryFilter(commentSubmittedFilter, startBlock)

    const reputationSubmittedFilter = unirepContract.filters.ReputationNullifierSubmitted()
    const reputationSubmittedEvents =  await unirepContract.queryFilter(reputationSubmittedFilter, startBlock)

    const epochEndedFilter = unirepContract.filters.EpochEnded()
    const epochEndedEvents =  await unirepContract.queryFilter(epochEndedFilter, startBlock)

    const userStateTransitionedFilter = unirepContract.filters.UserStateTransitioned()
    const userStateTransitionedEvents =  await unirepContract.queryFilter(userStateTransitionedFilter, startBlock)

    const sequencerFilter = unirepContract.filters.Sequencer()
    const sequencerEvents =  await unirepContract.queryFilter(sequencerFilter, startBlock)

    // Reverse the events so pop() can start from the first event
    newGSTLeafInsertedEvents.reverse()
    attestationSubmittedEvents.reverse()
    postSubmittedEvents.reverse()
    commentSubmittedEvents.reverse()
    reputationSubmittedEvents.reverse()
    epochEndedEvents.reverse()
    userStateTransitionedEvents.reverse()
    // Variables used to keep track of data required for user to transition
    let userHasSignedUp = false
    let currentEpochGSTLeafIndexToInsert = 0
    let epkNullifiers: BigInt[] = []
    for (let i = 0; i < sequencerEvents.length; i++) {
        const sequencerEvent = sequencerEvents[i]
        const occurredEvent = sequencerEvent.args?._event
        if (occurredEvent === "UserSignUp") {
            const newLeafEvent = newGSTLeafInsertedEvents.pop()
            assert(newLeafEvent !== undefined, `Event sequence mismatch: missing newGSTLeafInsertedEvent`)

            const newLeaf = BigInt(newLeafEvent.args?._hashedLeaf)
            unirepState.signUp(unirepState.currentEpoch, newLeaf)
            // New leaf matches user's default leaf means user signed up.
            if (userDefaultGSTLeaf === newLeaf) {
                userState.signUp(unirepState.currentEpoch, currentEpochGSTLeafIndexToInsert)
                userHasSignedUp = true
            }

            // A user sign up, increment (next) GST leaf index
            currentEpochGSTLeafIndexToInsert ++
        } else if (occurredEvent === "AttestationSubmitted") {
            const attestationEvent = attestationSubmittedEvents.pop()
            assert(attestationEvent !== undefined, `Event sequence mismatch: missing attestationSubmittedEvent`)
            const epoch = attestationEvent.args?._epoch.toNumber()
            assert(
                epoch === unirepState.currentEpoch,
                `Attestation epoch (${epoch}) does not match current epoch (${unirepState.currentEpoch})`
            )

            const _attestation = attestationEvent.args?.attestation
            const attestation = new Attestation(
                BigInt(_attestation.attesterId),
                BigInt(_attestation.posRep),
                BigInt(_attestation.negRep),
                BigInt(_attestation.graffiti),
                _attestation.overwriteGraffiti
            )
            const epochKey = attestationEvent.args?._epochKey
            unirepState.addAttestation(epochKey.toString(), attestation)
            if(userHasSignedUp){
                userState.updateAttestation(epochKey, attestation.posRep, attestation.negRep)
            }
        } else if (occurredEvent === "PostSubmitted") {
            const postEvent = postSubmittedEvents.pop()
            assert(postEvent !== undefined, `Event sequence mismatch: missing postSubmittedEvent`)
            const epoch = postEvent.args?._epoch.toNumber()
            assert(
                epoch === unirepState.currentEpoch,
                `Post epoch (${epoch}) does not match current epoch (${unirepState.currentEpoch})`
            )
        } else if (occurredEvent === "CommentSubmitted") {
            const commentEvent = commentSubmittedEvents.pop()
            assert(commentEvent !== undefined, `Event sequence mismatch: missing commentSubmittedEvent`)
            const epoch = commentEvent.args?._epoch.toNumber()
            assert(
                epoch === unirepState.currentEpoch,
                `Comment epoch (${epoch}) does not match current epoch (${unirepState.currentEpoch})`
            )
        } else if (occurredEvent === "ReputationNullifierSubmitted") {
            const reputationEvent = reputationSubmittedEvents.pop()
            assert(reputationEvent !== undefined, `Event sequence mismatch: missing ReputationNullifierSubmitted`)
            unirepState.addKarmaNullifiers(reputationEvent.args?.karmaNullifiers.map((n) => BigInt(n)))
        } else if (occurredEvent === "EpochEnded") {
            const epochEndedEvent = epochEndedEvents.pop()
            assert(epochEndedEvent !== undefined, `Event sequence mismatch: missing epochEndedEvent`)
            const epoch = epochEndedEvent.args?._epoch.toNumber()
            assert(
                epoch === unirepState.currentEpoch,
                `Ended epoch (${epoch}) does not match current epoch (${unirepState.currentEpoch})`
            )

            // Get epoch tree leaves of the ending epoch
            let [epochKeys_, epochKeyHashchains_] = await unirepContract.getEpochTreeLeaves(epoch)
            epochKeys_ = epochKeys_.map((epk) => BigInt(epk.toString()))
            epochKeyHashchains_ = epochKeyHashchains_.map((hc) => BigInt(hc.toString()))
            const epochTreeLeaves: IEpochTreeLeaf[] = []
            for (let i = 0; i < epochKeys_.length; i++) {
                const epochTreeLeaf: IEpochTreeLeaf = {
                    epochKey: epochKeys_[i],
                    hashchainResult: epochKeyHashchains_[i]
                }
                epochTreeLeaves.push(epochTreeLeaf)
            }

            unirepState.epochTransition(epoch, epochTreeLeaves)
            if (userHasSignedUp) {
                if (epoch === userState.latestTransitionedEpoch) {
                    // Latest epoch user transitioned to ends. Generate nullifiers of all epoch key
                    // so we can identify when user process the epoch keys.
                    epkNullifiers = userState.getEpochKeyNullifiers(epoch)
                }
            }

            // Epoch ends, reset (next) GST leaf index
            currentEpochGSTLeafIndexToInsert = 0
        } else if (occurredEvent === "UserStateTransitioned") {
            // const newLeafEvent = newGSTLeafInsertedEvents.pop()
            // assert(newLeafEvent !== undefined, `Event sequence mismatch: missing newGSTLeafInsertedEvent`)
            const userStateTransitionedEvent = userStateTransitionedEvents.pop()
            assert(userStateTransitionedEvent !== undefined, `Event sequence mismatch: missing userStateTransitionedEvent`)

            const newLeaf = userStateTransitionedEvent.args?.userTransitionedData.newGlobalStateTreeLeaf

            const isProofValid = await unirepContract.verifyUserStateTransition(
                newLeaf,
                userStateTransitionedEvent.args?.userTransitionedData.attestationNullifiers,
                userStateTransitionedEvent.args?.userTransitionedData.epkNullifiers,
                userStateTransitionedEvent.args?.userTransitionedData.fromEpoch,
                userStateTransitionedEvent.args?.userTransitionedData.fromGlobalStateTree,
                userStateTransitionedEvent.args?.userTransitionedData.fromEpochTree,
                userStateTransitionedEvent.args?.userTransitionedData.proof,
            )
            // Proof is invalid, skip this event
            if (!isProofValid) {
                console.log("Invalid UserStateTransitioned proof")
                continue
            }

            const attestationNullifiers = userStateTransitionedEvent.args?.userTransitionedData.attestationNullifiers.map((n) => BigInt(n))
            const epkNullifiers_ = userStateTransitionedEvent.args?.userTransitionedData.epkNullifiers.map((n) => BigInt(n))
            // Combine nullifiers and mod them
            const allNullifiers = attestationNullifiers.concat(epkNullifiers_).map((nullifier) => BigInt(nullifier) % BigInt(2 ** unirepState.nullifierTreeDepth))

            let isNullifierSeen = false
            // Verify nullifiers are not seen before
            for (const nullifier of allNullifiers) {
                if (nullifier === BigInt(0)) continue
                else {
                    if (userState.nullifierExist(nullifier)) {
                        isNullifierSeen = true
                        // If nullifier exists, the proof is considered invalid
                        console.log(`Invalid UserStateTransitioned proof: seen nullifier ${nullifier.toString()}`)
                        break
                    }
                }
            }
            if (isNullifierSeen) continue

            if (
                userHasSignedUp &&
                (userStateTransitionedEvent.args?.userTransitionedData.fromEpoch.toNumber() === userState.latestTransitionedEpoch)
            ) {
                let epkNullifiersMatched = 0
                for (const nullifier of epkNullifiers_) {
                    if (epkNullifiers.indexOf(nullifier % BigInt(2 ** unirepState.nullifierTreeDepth)) !== -1) epkNullifiersMatched++
                }
                if (epkNullifiersMatched == userState.numEpochKeyNoncePerEpoch) {
                    const newState = await userState.genNewUserStateAfterTransition()
                    userState.transition(newState.newUSTLeaves)
                    // User processed all epoch keys so non-zero GST leaf is generated.
                    assert(BigNumber.from(newState.newGSTLeaf).eq(newLeaf), 'New GST leaf mismatch')
                    // User transition to this epoch, increment (next) GST leaf index
                    currentEpochGSTLeafIndexToInsert ++
                } else if (epkNullifiersMatched > 0) {
                    throw new Error(`Number of epoch key nullifiers matched ${epkNullifiersMatched} not equal to numEpochKeyNoncePerEpoch ${numEpochKeyNoncePerEpoch}`)
                }
            }

            unirepState.userStateTransition(unirepState.currentEpoch, BigInt(newLeaf), allNullifiers)
        } else {
            throw new Error(`Unexpected event: ${occurredEvent}`)
        }
    }
    assert(userHasSignedUp, "User did not sign up")
    assert(newGSTLeafInsertedEvents.length == 0, `${newGSTLeafInsertedEvents.length} newGSTLeafInsert events left unprocessed`)
    assert(attestationSubmittedEvents.length == 0, `${attestationSubmittedEvents.length} attestationSubmitted events left unprocessed`)
    assert(epochEndedEvents.length == 0, `${epochEndedEvents.length} newGSTLeafInsert events left unprocessed`)
    assert(userStateTransitionedEvents.length == 0, `${userStateTransitionedEvents.length} newGSTLeafInsert events left unprocessed`)
    return userState
}

/*
 * Given user identity and userIdentityCommitment, retrieves and parses on-chain
 * Unirep contract data to create an off-chain representation as a
 * UserState object (including UnirepState object).
 * @param provider An Ethereum provider
 * @param address The address of the Unirep contract
 * @param startBlock The block number when Unirep contract is deployed
 * @param userIdentity The semaphore identity of the user
 * @param userIdentityCommitment Commitment of the userIdentity
 */
const genUserStateFromContract = async (
    provider: ethers.providers.Provider,
    address: string,
    startBlock: number,
    userIdentity: any,
    userIdentityCommitment: any,
) => {
    return await _genUserStateFromContract(
        provider,
        address,
        startBlock,
        userIdentity,
        userIdentityCommitment,
    )
}

export {
    genUnirepStateFromContract,
    genUserStateFromContract,
    genUserStateFromParams,
}