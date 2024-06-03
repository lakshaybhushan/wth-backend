import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { z } from "zod"
import sanitizeHtml from "sanitize-html"
import { streamText } from "hono/streaming"
import { cors } from "hono/cors"
import { EventSourceParserStream } from "eventsource-parser/stream"

type Bindings = {
  [key in keyof CloudflareBindings]: CloudflareBindings[key]
}

const app = new Hono<{ Bindings: Bindings }>()

app.use("*", cors())

app.use(
  "*",
  cors({
    origin: "http://localhost:3000",
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["POST", "GET", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
    credentials: true,
  })
)
app.options("*", (c) => {
  return c.text("", 204)
})

const isValidURL = (value: string) => {
  if (!value.startsWith("https://news.ycombinator.com/")) return false
  try {
    new URL(value)
    return true
  } catch (error) {
    return false
  }
}

app.get(
  "/",
  zValidator("query", z.object({ hnURL: z.string().refine(isValidURL) })),
  async (c) => {
    const { hnURL } = c.req.valid("query")

    const url = new URL(hnURL).toString()

    const res = await fetch(url)

    const rawHTML = await res.text()

    const comments = rawHTML.match(/<div class="commtext c00">(.*?)<\/div>/g)

    const heading = rawHTML.match(/<title>(.*?)<\/title>/g)

    if (!comments) {
      return c.text("No comments found")
    }

    const sanitizedComments = comments.map((comment) =>
      sanitizeHtml(comment, {
        allowedTags: [],
        allowedAttributes: {},
      })
    )

    const topComments = sanitizedComments.slice(0, 5)

    let eventSourceStream
    let retryCount = 0
    let successfulInference = false
    let lastError
    const MAX_RETRIES = 3

    while (successfulInference === false && retryCount < MAX_RETRIES) {
      try {
        eventSourceStream = (await c.env.AI.run(
          "@cf/meta/llama-3-8b-instruct",
          {
            prompt: `Create a summary of the top comments on Hacker News which is a website where programmers share their learnings with and what they are building, heading of the article is${heading} top comments being: ${topComments.join(
              "/n"
            )}`,
            stream: true,
          }
        )) as ReadableStream
        successfulInference = true
      } catch (err) {
        lastError = err
        retryCount++
        console.error(err)
        console.log(`Retrying #${retryCount}...`)
      }
    }
    if (eventSourceStream === undefined) {
      if (lastError) {
        throw lastError
      }
      throw new Error(`Problem with model`)
    }
    const tokenStream = eventSourceStream
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new EventSourceParserStream())

    return streamText(c, async (stream) => {
      for await (const msg of tokenStream) {
        if (msg.data !== "[DONE]") {
          const data = JSON.parse(msg.data)
          stream.write(data.response)
        }
      }
    })
  }
)

export default app
