import { createClient } from '@supabase/supabase-js';
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, set, remove } from 'firebase/database';
import { GoogleGenAI } from '@google/genai';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: `${process.env.FIREBASE_PROJECT_ID}.firebaseapp.com`,
  databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com`,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: `${process.env.FIREBASE_PROJECT_ID}.firebasestorage.app`,
  messagingSenderId: process.env.FIREBASE_MSG_SENDER_ID || "1035835919494",
  appId: process.env.FIREBASE_APP_ID,
  measurementId: process.env.FIREBASE_MEASUREMENT_ID
};

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-2.5-flash';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

async function runWorkerBatch() {
  console.log("🔄 Starting PentAGI GitHub Action Batch Check...");
  try {
    const { data: reports, error } = await supabase
      .from('reports')
      .select('*')
      .eq('status', 'pending');

    if (error) throw error;

    if (!reports || reports.length === 0) {
      console.log("✅ No pending reports found. Exiting process.");
      process.exit(0);
    }

    for (const report of reports) {
      console.log(`[Sync] Processing report: ${report.tracking_code}`);
      
      await set(ref(db, `pentagi_reports/${report.id}`), {
        ...report,
        pentagi_status: 'processing',
        migrated_at: new Date().toISOString()
      });

      await supabase
        .from('reports')
        .update({ status: 'AI Processing' })
        .eq('id', report.id);

      try {
        const prompt = `
        You are PentAGI, an autonomous cybersecurity and MFS fraud investigator. Analyze this incident report:
        Category: ${report.category}
        Description: ${report.description}
        Loss: ${report.financial_loss || 0} BDT

        Return a strict JSON format with:
        - "threat_score" (number 1-10)
        - "technical_summary" (string analysis and investigation brief)
        - "requires_human_escalation" (boolean: true if autonomous resolution fails or high-risk manual human team intervention is required)
        `;

        const response = await ai.models.generateContent({
          model: GEMINI_MODEL,
          contents: prompt,
          config: { responseMimeType: 'application/json' }
        });

        const result = JSON.parse(response.text);

        if (result.requires_human_escalation) {
          const targetStatus = report.category && report.category.toLowerCase().includes('mfs') 
            ? 'MFS Team Working' 
            : 'Cyber Security Team Working';

          await supabase
            .from('reports')
            .update({
              status: targetStatus,
              technical_summary: result.technical_summary
            })
            .eq('id', report.id);

          await remove(ref(db, `pentagi_reports/${report.id}`));
          console.log(`[Escalated] ${report.tracking_code} sent to human team portal.`);
        } else {
          await supabase
            .from('reports')
            .update({ 
              status: 'Completed', 
              technical_summary: result.technical_summary 
            })
            .eq('id', report.id);

          await remove(ref(db, `pentagi_reports/${report.id}`));
          console.log(`[Resolved] ${report.tracking_code} resolved autonomously.`);
        }

      } catch (aiErr) {
        console.error(`[AI Error] Failed for ${report.tracking_code}:`, aiErr.message);
        await supabase
          .from('reports')
          .update({
            status: 'Cyber Security Team Working',
            technical_summary: 'AI Processing Exception / Manual review required.'
          })
          .eq('id', report.id);
        await remove(ref(db, `pentagi_reports/${report.id}`));
      }
    }

    console.log("🏁 Batch execution completed successfully.");
    process.exit(0);
  } catch (err) {
    console.error('[Worker Error]:', err.message);
    process.exit(1);
  }
}

runWorkerBatch();