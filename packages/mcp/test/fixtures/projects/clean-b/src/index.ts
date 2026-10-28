import express from 'express'
import { PrivateKey } from '@bsv/sdk'
import { Setup } from '@bsv/wallet-toolbox'

// Shape B: the server holds the operator's root key, read from the environment (never committed).
const rootKey = PrivateKey.fromHex(process.env.SERVER_PRIVATE_KEY ?? '')

const wallet = await Setup.createWalletSQLite({
  chain: 'test',
  rootKeyHex: rootKey.toHex(),
  filePath: './wallet.sqlite',
  databaseName: 'wallet',
})

const app = express()
app.use(express.json())

app.post('/pay', async (req, res) => {
  const { txid } = await wallet.createAction({
    description: 'Pay a user',
    outputs: [{ lockingScript: req.body.lockingScript, satoshis: req.body.satoshis, outputDescription: 'payout' }],
  })
  res.json({ txid })
})

app.listen(3000)
