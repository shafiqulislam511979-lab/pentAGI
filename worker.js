import ws from 'ws';
import { createClient } from '@supabase/supabase-js';
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, set } from 'firebase/database';
import { GoogleGenAI } from '@google/genai';

// Environment variable validation
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const geminiApiKey = process.env.GEMINI_API_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Error: SUPABASE_URL and SUPABASE_KEY must be provided.");
  process.exit(1);
}

// Initialize Supabase Client with ws transport for Node 20 compatibility
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
  realtime: { transport: ws }
});

// Initialize Firebase App & Realtime Database
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  projectId: process.env.FIREBASE_PROJECT_ID,
  appId: process.env.FIREBASE_APP_ID,
  databaseURL: process.env.FIREBASE_DATABASE_URL || `https://${process.env.FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com`
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);

// Initialize Gemini AI Client
const ai = new GoogleGenAI({ apiKey: geminiApiKey });

async function runWorker() {
  console.log("Starting PentAGI automated worker execution...");

  // 1. Fetch pending reports from Supabase
  const { data: reports, error } = await supabase
    .from('cyber_reports')
    .select('*')
    .eq('status', 'pending')
    .limit(5);

  if (error) {
    console.error("Error fetching reports from Supabase:", error.message);
    process.exit(1);
  }

  if (!reports || reports.length === 0) {
    console.log("No pending cyber incident reports found.");
    return;
  }

  console.log(`Found ${reports.length} pending report(s) to process.`);

  for (const report of reports) {
    try {
      console.log(`Processing incident report ID: ${report.id}`);

      // 2. Perform AI Triage using Gemini 2.5 Flash
      const prompt = `Analyze this cyber incident report and provide a risk severity rating (Low, Medium, High, Critical) along with brief triage and response recommendations:
      Title: ${report.title || 'N/A'}
      Description: ${report.description || report.details || 'N/A'}`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
      });

      const analysisText = response.text || "No AI analysis generated.";
      console.log(`AI triage completed for report ID: ${report.id}`);

      // 3. Stage the analyzed data into Firebase Realtime Database
      const stagedRef = ref(db, `staged_incidents/${report.id}`);
      await set(stagedRef, {
        ...report,
        aiAnalysis: analysisText,
        processedAt: new Date().toISOString()
      });

      // 4. Update status in Supabase to processed
      const { error: updateError } = await supabase
        .from('cyber_reports')
        .update({ status: 'processed', analysis: analysisText })
        .eq('id', report.id);

      if (updateError) {
        console.error(`Failed to update Supabase status for report ${report.id}:`, updateError.message);
      } else {
        console.log(`Successfully processed, staged, and updated report ID: ${report.id}`);
      }
    } catch (err) {
      console.error(`Error processing report ${report.id}:`, err.message);
    }
  }

  console.log("PentAGI worker execution cycle finished successfully.");
}

runWorker().catch(err => {
  console.error("Fatal worker error:", err);
  process.exit(1);
});
