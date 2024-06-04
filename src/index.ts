import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import sanitizeHtml from "sanitize-html"
import { streamText } from "hono/streaming"
import { cors } from "hono/cors"
import { EventSourceParserStream } from "eventsource-parser/stream"
import { Context, Hono } from "hono"

type Bindings = {
  [key in keyof CloudflareBindings]: CloudflareBindings[key]
}

const app = new Hono<{ Bindings: Bindings }>()

app.use("*", cors())

app.use(
  "*",
  cors({
    origin: "*",
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

const fetchAndSanitizeData = async (hnURL: string) => {
  const url = new URL(hnURL).toString()
  const res = await fetch(url)
  const rawHTML = await res.text()

  const comments = rawHTML.match(/<div class="commtext c00">([\s\S]*?)<\/div>/g)
  const heading = rawHTML.match(/<title>(.*?)<\/title>/)

  if (!heading || heading.length < 1) {
    throw new Error("No heading found")
  }
  if (!comments) {
    throw new Error("No comments found")
  }

  const sanitizedHeading = heading.map((h) =>
    sanitizeHtml(h, {
      allowedTags: [],
      allowedAttributes: {},
    })
  )

  const sanitizedComments = comments.map((comment) =>
    sanitizeHtml(comment, {
      allowedTags: [],
      allowedAttributes: {},
    })
  )

  return { sanitizedHeading, sanitizedComments }
}

const processInference = async (
  c: Context<{ Bindings: Bindings }>,
  sanitizedHeading: string[],
  topComments: string[]
): Promise<ReadableStream> => {
  let eventSourceStream
  let retryCount = 0
  let successfulInference = false
  let lastError
  const MAX_RETRIES = 3

  while (!successfulInference && retryCount < MAX_RETRIES) {
    try {
      eventSourceStream = (await c.env.AI.run("@cf/meta/llama-3-8b-instruct", {
        prompt: `You are HackerNews simple markdown summarizer, your job is to summarise comments of a Hacker News post. The format of the output that will be generated is a simple markdown content where heading is denoted through # or h1 tag and summary will be in points with their subheadings in detailed manner. Here is the heading of the post: ${sanitizedHeading}. Here are the comments: ${topComments.join(
          "\n"
        )}. DON'T ADD LINKS OR IMAGES. DON'T ADD ANYTHING ELSE.`,
        stream: true,
      })) as ReadableStream
      successfulInference = true
    } catch (err) {
      lastError = err
      retryCount++
      console.error(err)
      console.log(`Retrying #${retryCount}...`)
    }
  }
  if (!eventSourceStream) {
    if (lastError) {
      throw lastError
    }
    throw new Error("Problem with model")
  }
  return eventSourceStream
}

app.get(
  "/",
  zValidator("query", z.object({ hnURL: z.string().refine(isValidURL) })),
  async (c) => {
    const { hnURL } = c.req.valid("query")

    let sanitizedHeading, sanitizedComments
    try {
      ;({ sanitizedHeading, sanitizedComments } = await fetchAndSanitizeData(
        hnURL
      ))
    } catch (error) {
      return c.text((error as Error).message)
    }

    const topComments = sanitizedComments.slice(0, 5)

    const eventSourceStream = await processInference(
      c,
      sanitizedHeading,
      topComments
    )

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

app.get(
  "/image",
  zValidator("query", z.object({ hnURL: z.string().refine(isValidURL) })),
  async (c) => {
    console.log("Request received for /generate-image")

    const { hnURL } = c.req.valid("query")

    let sanitizedHeading

    try {
      ;({ sanitizedHeading } = await fetchAndSanitizeData(hnURL))
    } catch (error) {
      return c.text((error as Error).message)
    }

    const imageResponse = await c.env.AI.run("@cf/lykon/dreamshaper-8-lcm", {
      prompt: `Illustrative image for heading: ${sanitizedHeading}, high quality, 8k, high detail`,
    })

    console.log(sanitizedHeading)

    return new Response(imageResponse, {
      headers: {
        "Content-Type": "image/png",
      },
    })
  }
)

export default app
