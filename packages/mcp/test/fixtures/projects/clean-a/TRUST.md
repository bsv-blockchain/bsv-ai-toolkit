# Trust model

The page holds no keys. Every signature and payment is approved in the user's wallet under the grouped
permission in `public/manifest.json`. A tip counts once Arcade reports it `SEEN_ON_NETWORK` with no competing
transaction; the app never waits for a block.
