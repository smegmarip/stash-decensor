import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = express()
const PORT = parseInt(process.env.PORT || '5031', 10)
const API_URL = process.env.DECENSOR_API_URL || 'http://decensor-api:5030'

app.use('/decensor', createProxyMiddleware({
  target: API_URL,
  changeOrigin: true,
  ws: true,
}))

app.use(express.static(path.join(__dirname, '../dist')))

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../dist/index.html'))
})

app.listen(PORT, () => {
  console.log(`Jobs viewer running on port ${PORT}`)
  console.log(`Proxying API requests to ${API_URL}`)
})
