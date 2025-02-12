include "./hasherPoseidon.circom";
include "./identityCommitment.circom";
include "./incrementalMerkleTree.circom";

template userExists(GST_tree_depth){
    // Global state tree
    signal private input GST_path_index[GST_tree_depth];
    signal private input GST_path_elements[GST_tree_depth][1];
    signal input GST_root;
    // Global state tree leaf: Identity & user state root
    signal private input identity_pk[2];
    signal private input identity_nullifier;
    signal private input identity_trapdoor;
    signal private input user_tree_root;
    signal private input user_state_hash;
    // Sum of positive and negative karma
    signal private input positive_karma;
    signal private input negative_karma;
    signal output out;

    component identity_commitment = IdentityCommitment();
    identity_commitment.identity_pk[0] <== identity_pk[0];
    identity_commitment.identity_pk[1] <== identity_pk[1];
    identity_commitment.identity_nullifier <== identity_nullifier;
    identity_commitment.identity_trapdoor <== identity_trapdoor;
    out <== identity_commitment.out;

    // Compute user state tree root
    component leaf_hasher = Hasher5();
    leaf_hasher.in[0] <== identity_commitment.out;
    leaf_hasher.in[1] <== user_tree_root;
    leaf_hasher.in[2] <== positive_karma;
    leaf_hasher.in[3] <== negative_karma;
    leaf_hasher.in[4] <== 0;

    // 3.4 Check computed hash == user state tree leaf
    leaf_hasher.hash === user_state_hash;

    // 3.6 Check if user state hash is in GST
    component GST_leaf_exists = LeafExists(GST_tree_depth);
    GST_leaf_exists.leaf <== leaf_hasher.hash;
    for (var i = 0; i < GST_tree_depth; i++) {
        GST_leaf_exists.path_index[i] <== GST_path_index[i];
        GST_leaf_exists.path_elements[i][0] <== GST_path_elements[i][0];
    }
    GST_leaf_exists.root <== GST_root;
}