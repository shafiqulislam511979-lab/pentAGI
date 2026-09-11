import { createClient } from '@supabase/supabase-js';
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, set, remove, onChildAdded } from 'firebase/database';
import { GoogleGenAI } from '@google/genai';

// --- CONFIGURATION ---
const SUPABASE_URL = 'https://qaeapwvrkzjxlydtfoih.supabase.co';
const SUPABASE_KEY = 'sb_publishable_90Kud0TkeMWtNvfOvttjIw_bk4PUxCH';

const firebaseConfig = {
  apiKey: "AIzaSyBYRa09xQho9jeLU8n-9nIPdVEKBBZpgiA",
  authDomain: "cyber-helpline.firebaseapp.com",
  databaseURL: "https://cyber-helpline-default-rtdb.firebaseio.com",
  projectId: "cyber-helpline",
  storageBucket: "cyber-helpline.firebasestorage.app",
  messagingSenderId: "1035835919494",
  appId: "1:1035835919494:web:e847057cc89c89a6c75507",
  measurementId: "G-FB11JCN347"
};

const GEMINI_API_KEY = 'AQ.Ab8RN6IWjzXnOXBqbOzxTKpiu1aaRQfsGX4H60Seo93qIMTH3g';
const GEMINI_MODEL = 'gemini-2.5-flash';

// --- CLIENT INITIALIZATION ---
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// --- STEP 1: Poll Supabase Reports & Push to PentAGI Firebase ---
async function pollSupabaseReports() {
  try {
    const { data: reports, error } = await supabase
      .from('reports')
      .select('*')
      .eq('status', 'pending');

    if (error) throw error;

    if (reports && reports.length > 0) {
      for (const report of reports) {
        console.log(`[Sync] Moving report ${report.tracking_code} to PentAGI Firebase RTDB...`);
        
        await set(ref(db, `pentagi_reports/${report.id}`), {
          ...report,
          pentagi_status: 'processing',
          migrated_at: new Date().toISOString()
        });

        await supabase
          .from('reports')
          .update({ status: 'AI Processing' })
          .eq('id', report.id);
      }
    }
  } catch (err) {
    console.error('[Supabase Polling Error]:', err.message);
  }
}

// --- STEP 2: PentAGI Processing via Gemini AI Layer ---
function listenFirebaseReports() {
  const reportsRef = ref(db, 'pentagi_reports');
  
  onChildAdded(reportsRef, async (snapshot) => {
    const reportId = snapshot.key;
    const reportData = snapshot.val();

    if (reportData && reportData.pentagi_status === 'processing') {
      console.log(`[PentAGI] Analyzing report ${reportData.tracking_code} using model: ${GEMINI_MODEL}...`);
      
      try {
        const prompt = `
        You are PentAGI, an autonomous cybersecurity and MFS fraud investigator. Analyze this incident report:
        Category: ${reportData.category}
        Description: ${reportData.description}
        Loss: ${reportData.financial_loss || 0} BDT

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
          console.log(`[PentAGI] Escalation required for ${reportData.tracking_code}. Handing over to Human Operations Team.`);
          await escalateToHumanTeam(reportId, reportData, result);
        } else {
          await supabase
            .from('reports')
            .update({ 
              status: 'Completed', 
              technical_summary: result.technical_summary 
            })
            .eq('id', reportId);

          await remove(ref(db, `pentagi_reports/${reportId}`));
          console.log(`[PentAGI] Successfully resolved report autonomously: ${reportData.tracking_code}`);
        }

      } catch (error) {
        console.error(`[PentAGI Error] Processing failed for ${reportId}:`, error);
        await escalateToHumanTeam(reportId, reportData, {
          technical_summary: "AI Processing Failed / System Exception. Manual review required by security operations team."
        });
      }
    }
  });
}

// --- STEP 3: Firebase to Supabase Back-Migration ---
async function escalateToHumanTeam(reportId, reportData, aiResult) {
  const targetStatus = reportData.category && reportData.category.toLowerCase().includes('mfs') 
    ? 'MFS Team Working' 
    : 'Cyber Security Team Working';

  console.log(`[Migration] Transferring ${reportData.tracking_code} back to Supabase portal with status: "${targetStatus}"`);

  const { error } = await supabase
    .from('reports')
    .update({
      status: targetStatus,
      technical_summary: aiResult.technical_summary
    })
    .eq('id', reportId);

  if (!error) {
    await remove(ref(db, `pentagi_reports/${reportId}`));
    console.log(`[Migration] Successfully transferred ${reportData.tracking_code} to human team portal.`);
  } else {
    console.error(`[Migration Error] Failed to update Supabase:`, error.message);
  }
}

// --- RUN WORKER ---
setInterval(pollSupabaseReports, 10000); // Check Supabase every 10 seconds
listenFirebaseReports();               // Listen to Firebase RTDB child additions
console.log("🚀 PentAGI Worker running on Render with Supabase, Firebase, and Gemini 2.5 Flash layer...");