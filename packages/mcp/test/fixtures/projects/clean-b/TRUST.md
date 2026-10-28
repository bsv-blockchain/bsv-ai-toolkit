# Trust model

The server holds the operator's root key, read from the environment and never committed. It pays users from
its own wallet and can spend only what that wallet holds. A payout counts once Arcade reports it
`SEEN_ON_NETWORK` with no competing transaction; the server never waits for a block.
