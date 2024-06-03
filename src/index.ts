import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { z } from "zod"
import sanitizeHtml from "sanitize-html"

type Bindings = {
  [key in keyof CloudflareBindings]: CloudflareBindings[key]
}

const app = new Hono<{ Bindings: Bindings }>()

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

    console.log(heading)

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

    const ai = (await c.env.AI.run("@cf/meta/llama-3-8b-instruct", {
      prompt: `Create a summary of the top comments on Hacker News which is a website where programmers share their learnings with and what they are building, heading of the article is${heading} top comments being: ${topComments.join(
        "/n"
      )}`,
    })) as { response: string }

    return c.json({ response: ai.response })
  }
)

export default app
