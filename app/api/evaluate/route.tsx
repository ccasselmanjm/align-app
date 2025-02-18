import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { InputOutput } from '@/app/lib/definitions';
import { fetchInputOutput, fetchExplanationPrediction } from '@/app/lib/data';
import { NextResponse } from 'next/server';
import { insertExplanationPrediction } from '@/app/lib/actions';
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

// Initialize Anthropic client
let anthropic: Anthropic;
try {
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    throw new Error('ANTHROPIC_API_KEY is missing');
  }
  anthropic = new Anthropic({ apiKey: anthropicApiKey });
} catch (error) {
  console.error('Error initializing Anthropic client:', error);
  throw error;
}

// Initialize OpenAI client
let openai: OpenAI;
try {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (!openaiApiKey) {
    throw new Error('OPENAI_API_KEY is missing');
  }
  openai = new OpenAI({ apiKey: openaiApiKey });
} catch (error) {
  console.error('Error initializing OpenAI client:', error);
  throw error;
}

let isEvaluationRunning = false;
const anthropicModel = process.env.ANTHROPIC_HAIKU3 || 'claude-3-haiku-20240307';
const openaiModel = process.env.OPENAI_4O_MINI || 'gpt-4o-mini';

const EvaluationResponse = z.object({
  explanation: z.string(),
  prediction: z.string().refine((val) => val === '0' || val === '1')
});

function createClaudePromptContent(userPrompt: string, inputData: string, outputData: string, evaluationFields: 'inputAndOutput' | 'outputOnly') {
  const inputSection = evaluationFields === 'inputAndOutput' ? `<input>${inputData}</input>` : '';
  
  return `${userPrompt}

${inputSection}
<output>${outputData}</output>

Evaluate the output based on the provided criteria. First, in the <sketchpad> provided, think through your evaluation step by step.

Then, provide a binary prediction (0 or 1) within <prediction>.`;
}

function extractContent(text: string, tag: string): string {
  const regex = new RegExp(`<${tag}>(.*?)</${tag}>`, 's')
  const match = text.match(regex)
  return match ? match[1].trim() : ''
}

async function processRowViaClaude(prompt: string, row: InputOutput, evaluationFields: 'inputAndOutput' | 'outputOnly', fileName: string) {
  const promptContent = createClaudePromptContent(prompt, row.input, row.output, evaluationFields)
  
  const response = await anthropic.messages.create({
    model: anthropicModel,
    max_tokens: 1000,
    messages: [
      { role: 'user', content: promptContent },
      { role: 'assistant', content: '<sketchpad>' },
    ],
  })

  const content = response.content[0].type === 'text' 
    ? `<sketchpad>${response.content[0].text}`
    : '<sketchpad></sketchpad>'
  const explanation = extractContent(content, 'sketchpad')
  const prediction = extractContent(content, 'prediction')
  console.log(`Claude response: ${explanation.slice(0, 40)}... ${prediction}`)

  await insertExplanationPrediction(fileName, row.id, explanation, prediction);
}

function createGptPromptContent(userPrompt: string, inputData: string, outputData: string, evaluationFields: 'inputAndOutput' | 'outputOnly') {
  const inputSection = evaluationFields === 'inputAndOutput' ? `${inputData}` : '';
  
  return {
    systemPrompt: `${userPrompt}

Evaluate the output based on the provided criteria. First, think through your evaluation step by step and return this in the json response as the explanation field.

Then, provide a binary prediction (0 or 1) in the json response as the prediction field.`,
    userPrompt: `Input: ${inputSection}\n\nOutput: ${outputData}`
  };
}

async function processRowViaGpt(prompt: string, row: InputOutput, evaluationFields: 'inputAndOutput' | 'outputOnly', fileName: string) {
  const { systemPrompt, userPrompt } = createGptPromptContent(prompt, row.input, row.output, evaluationFields)
  
  const completion = await openai.beta.chat.completions.parse({
    model: openaiModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    response_format: zodResponseFormat(EvaluationResponse, "evaluation"),
  });

  const result = completion.choices[0].message.parsed;

  // Check if result is null before proceeding
  if (!result) {
    console.error('No result returned from GPT');
    return; // Exit the function if result is null
  }

  console.log(`GPT response: ${result.explanation.slice(0, 40)}... ${result.prediction}`);
  await insertExplanationPrediction(fileName, row.id, result.explanation, result.prediction.toString());
}

async function processRows(prompt: string, data: InputOutput[], evaluationFields: 'inputAndOutput' | 'outputOnly', fileName: string, model: 'claude-3-haiku-20240307' | 'gpt-4o-mini') {
  const processRow = model === 'claude-3-haiku-20240307' ? processRowViaClaude : processRowViaGpt;
  
  for (const row of data) {
    if (!isEvaluationRunning) break;
    try {
      await processRow(prompt, row, evaluationFields, fileName);
    } catch (error) {
      console.error(`Error processing row ${row.id}:`, error);
      // Continue with next row even if current one fails
    }
  }
  isEvaluationRunning = false;
}

// Start evaluation process
export async function POST(req: Request) {
  const { prompt, evaluationFields, fileName, model } = await req.json()

  if (!fileName) {
    return NextResponse.json({ error: 'File name is required' }, { status: 400 })
  }

  const data = await fetchInputOutput(fileName);
  isEvaluationRunning = true;

  // Update metrics
  const protocol = process.env.NODE_ENV === 'development' ? 'http' : 'https'
  const host = req.headers.get('host') || 'localhost:3000'
  const baseUrl = `${protocol}://${host}`

  // Don't await these requests
  fetch(`${baseUrl}/api/site-metrics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      metric_name: 'evaluate_file_count',
      increment_by: 1
    })
  }).catch(error => console.error('Error updating file count metric:', error))

  fetch(`${baseUrl}/api/site-metrics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      metric_name: 'evaluate_row_count',
      increment_by: data.length
    })
  }).catch(error => console.error('Error updating row count metric:', error))

  processRows(prompt, data, evaluationFields, fileName, model)

  return NextResponse.json({ message: 'Processing started' }, { status: 202 })
}

// Get explanations and predictions  (TODO: Do we need this?)
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const fileName = searchParams.get('fileName')
  
  if (!fileName) {
    return NextResponse.json({ error: 'File name is required' }, { status: 400 })
  }

  
  const results = await fetchExplanationPrediction(fileName);
  return NextResponse.json({ results, isEvaluationRunning }, { status: 200 })
}

// Stop evaluation process
export async function DELETE() {
  isEvaluationRunning = false;
  return NextResponse.json({ message: 'Evaluation stopped' }, { status: 200 })
}
