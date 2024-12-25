import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { YoutubeTranscript } from 'youtube-transcript';
import fetch from 'node-fetch';

dotenv.config();

const app = express();

app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://127.0.0.1:5173', 
    'http://localhost:5174',
    'http://127.0.0.1:5174',
    'http://192.168.1.100:5173',
    'http://192.168.1.100:5174',
    process.env.FRONTEND_URL, // Add your frontend production URL
  ].filter(Boolean), // Remove any undefined values
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Helper function to extract video ID from YouTube URL
function extractVideoId(url) {
  try {
    if (!url) return null;
    url = url.trim().replace(/^@/, '');
    
    const urlObj = new URL(url);
    let videoId = null;

    if (urlObj.hostname.includes('youtube.com')) {
      videoId = urlObj.searchParams.get('v');
    } else if (urlObj.hostname.includes('youtu.be')) {
      const pathParts = urlObj.pathname.split('/').filter(Boolean);
      videoId = pathParts[0]?.split('?')[0]; // Remove query parameters
    }

    return videoId && videoId.length === 11 ? videoId : null;
  } catch {
    return null;
  }
}

// Store transcripts and analysis in memory
const transcriptCache = new Map();
const videoAnalysisCache = new Map();

// Function to format duration in HH:MM:SS
function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

// Function to chunk transcript into smaller parts with timestamps
function chunkTranscript(transcript) {
  const chunks = [];
  let currentChunk = [];
  let currentLength = 0;
  let totalDuration = 0;
  const MAX_CHUNK_LENGTH = 1500; // Increased for better context

  for (const item of transcript) {
    currentChunk.push(item);
    currentLength += item.text.length;
    totalDuration += item.duration || 0;

    if (currentLength >= MAX_CHUNK_LENGTH) {
      chunks.push({
        text: currentChunk.map(i => i.text).join(' '),
        startTime: currentChunk[0].offset,
        endTime: currentChunk[currentChunk.length - 1].offset + currentChunk[currentChunk.length - 1].duration,
        items: currentChunk
      });
      currentChunk = [];
      currentLength = 0;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push({
      text: currentChunk.map(i => i.text).join(' '),
      startTime: currentChunk[0].offset,
      endTime: currentChunk[currentChunk.length - 1].offset + currentChunk[currentChunk.length - 1].duration,
      items: currentChunk
    });
  }

  return { chunks, totalDuration };
}

// Function to get relevant chunks for a timestamp or topic
function getRelevantChunks(chunks, query, analysis) {
  // If query contains a timestamp
  const timeRegex = /(\d{1,2}:)?(\d{1,2}:\d{2}|\d{1,2})/;
  const timeMatch = query.match(timeRegex);
  
  if (timeMatch) {
    const timestamp = timeMatch[0];
    const targetSeconds = timestamp.split(':').reduce((acc, val) => acc * 60 + parseInt(val), 0);
    const window = 300; // 5 minutes window
    
    return chunks.filter(chunk => {
      const chunkStart = chunk.startTime;
      const chunkEnd = chunk.endTime;
      return (chunkStart >= targetSeconds - window && chunkStart <= targetSeconds + window) ||
             (chunkEnd >= targetSeconds - window && chunkEnd <= targetSeconds + window);
    });
  }

  // If query mentions a topic or concept from analysis
  const topics = analysis.mainTopics.map(t => t.topic.toLowerCase());
  const concepts = analysis.keyConcepts.map(c => c.concept.toLowerCase());
  const queryLower = query.toLowerCase();
  
  const matchedTopic = topics.find(t => queryLower.includes(t));
  const matchedConcept = concepts.find(c => queryLower.includes(c));
  
  if (matchedTopic) {
    const topic = analysis.mainTopics.find(t => t.topic.toLowerCase() === matchedTopic);
    if (topic && topic.timestamp) {
      const targetSeconds = topic.timestamp.split(':').reduce((acc, val) => acc * 60 + parseInt(val), 0);
      const window = 300;
      return chunks.filter(chunk => {
        const chunkStart = chunk.startTime;
        const chunkEnd = chunk.endTime;
        return (chunkStart >= targetSeconds - window && chunkStart <= targetSeconds + window) ||
               (chunkEnd >= targetSeconds - window && chunkEnd <= targetSeconds + window);
      });
    }
  }

  // Return most relevant chunks based on text similarity
  return chunks.filter(chunk => {
    const chunkText = chunk.text.toLowerCase();
    const words = queryLower.split(' ').filter(w => w.length > 3);
    return words.some(word => chunkText.includes(word));
  });
}

// Function to create optimized chat context
function createChatContext(query, metadata, analysis, relevantChunks, language = 'en') {
  // Find relevant topics and concepts
  const queryLower = query.toLowerCase();
  const relevantTopics = analysis.mainTopics
    .filter(t => t.topic.toLowerCase().includes(queryLower) || queryLower.includes(t.topic.toLowerCase()))
    .slice(0, 3);
  
  const relevantConcepts = analysis.keyConcepts
    .filter(c => c.concept.toLowerCase().includes(queryLower) || queryLower.includes(c.concept.toLowerCase()))
    .slice(0, 3);

  // Create focused context based on language
  return language === 'ms'
    ? `Video: "${metadata.title}" (${formatDuration(metadata.duration)})

${relevantTopics.length > 0 ? `Topik Berkaitan:
${relevantTopics.map(t => `[${t.timestamp}] ${t.topic}: ${t.description}`).join('\n')}` : ''}

${relevantConcepts.length > 0 ? `Konsep Penting:
${relevantConcepts.map(c => `${c.concept}: ${c.definition}`).join('\n')}` : ''}

Bahagian transkrip yang berkaitan:
${relevantChunks.map(chunk => 
  `[${formatDuration(chunk.startTime)} - ${formatDuration(chunk.endTime)}]
${chunk.text}`).join('\n\n')}

Soalan: ${query}`
    : `Video: "${metadata.title}" (${formatDuration(metadata.duration)})

${relevantTopics.length > 0 ? `Relevant Topics:
${relevantTopics.map(t => `[${t.timestamp}] ${t.topic}: ${t.description}`).join('\n')}` : ''}

${relevantConcepts.length > 0 ? `Relevant Concepts:
${relevantConcepts.map(c => `${c.concept}: ${c.definition}`).join('\n')}` : ''}

Relevant transcript sections:
${relevantChunks.map(chunk => 
  `[${formatDuration(chunk.startTime)} - ${formatDuration(chunk.endTime)}]
${chunk.text}`).join('\n\n')}

Question: ${query}`;
}

// Function to analyze transcript and extract key concepts
async function analyzeTranscript(transcript, metadata, language = 'en') {
  const { chunks } = chunkTranscript(transcript);
  
  const fullTranscript = chunks.map(chunk => 
    `[${formatDuration(chunk.startTime)}] ${chunk.text}`
  ).join('\n');

  const systemPrompt = language === 'ms' 
    ? `Anda adalah penganalisis kandungan video yang tepat. Tugas anda adalah untuk:
       1. Menganalisis keseluruhan video dari awal hingga akhir
       2. Berikan timestamp yang tepat untuk semua poin utama
       3. Pastikan liputan menyeluruh tanpa jurang yang ketara
       4. Kembalikan hanya JSON yang sah tanpa markdown atau blok kod
       5. Simpan semua timestamp dalam format MM:SS atau HH:MM:SS
       6. Pastikan topik-topik diedarkan secara seimbang sepanjang video`
    : `You are a precise video content analyzer. Your task is to:
       1. Analyze the entire video from start to finish
       2. Provide accurate timestamps for all major points
       3. Ensure comprehensive coverage with no significant gaps
       4. Return only valid JSON with no markdown or code blocks
       5. Keep all timestamps in MM:SS or HH:MM:SS format
       6. Ensure even distribution of topics throughout the video length`;

  const analysisPrompt = language === 'ms'
    ? `Analisis video ${formatDuration(metadata.duration)} ini bertajuk "${metadata.title}".
       Video ini mengandungi ${chunks.length} segmen.

       Buat analisis komprehensif yang merangkumi KESELURUHAN durasi video dari awal hingga akhir.
       Bahagikan video kepada bahagian-bahagian yang logik dan kenalpasti saat-saat penting, pastikan tiada bahagian utama yang tertinggal.

       Keperluan:
       1. Kenalpasti topik/peristiwa setiap 2-3 minit
       2. Liputi keseluruhan video dari 0:00 hingga ${formatDuration(metadata.duration)}
       3. Sertakan topik tahap tinggi dan butiran khusus
       4. Catat semua peralihan utama antara topik
       5. Tangkap konsep utama semasa ia diperkenalkan
       6. Pastikan timestamp tepat dan diagihkan secara seimbang

       Berikut adalah transkrip lengkap:
       ${fullTranscript}

       Balas dengan HANYA objek JSON dalam format tepat ini (tanpa markdown, tanpa blok kod):
       {
         "summary": "Gambaran keseluruhan kandungan video",
         "mainTopics": [
           {
             "topic": "Nama topik atau bahagian tertentu",
             "timestamp": "MM:SS",
             "description": "Apa yang dibincangkan atau dipersembahkan"
           }
         ],
         "keyConcepts": [
           {
             "concept": "Istilah atau idea penting",
             "definition": "Penjelasan jelas tentang konsep"
           }
         ],
         "timeline": [
           {
             "time": "MM:SS",
             "event": "Peristiwa atau poin perbincangan tertentu"
           }
         ]
       }`
    : `Analyze this ${formatDuration(metadata.duration)} video titled "${metadata.title}".
       The video contains ${chunks.length} segments.

       Create a comprehensive analysis that covers the ENTIRE video duration from start to finish.
       Divide the video into logical sections and identify key moments, ensuring no major part is missed.

       Requirements:
       1. Identify a topic/event every 2-3 minutes
       2. Cover the full video length from 0:00 to ${formatDuration(metadata.duration)}
       3. Include both high-level topics and specific details
       4. Note all major transitions between topics
       5. Capture key concepts as they are introduced
       6. Ensure timestamps are accurate and evenly distributed

       Here's the full transcript:
       ${fullTranscript}

       Respond with ONLY a JSON object in this exact format (no markdown, no code blocks):
       {
         "summary": "Comprehensive overview of the entire video content",
         "mainTopics": [
           {
             "topic": "Specific topic or section name",
             "timestamp": "MM:SS",
             "description": "What is discussed or presented"
           }
         ],
         "keyConcepts": [
           {
             "concept": "Important term or idea",
             "definition": "Clear explanation of the concept"
           }
         ],
         "timeline": [
           {
             "time": "MM:SS",
             "event": "Specific event or discussion point"
           }
         ]
       }`;

  try {
    const analysis = await openai.chat.completions.create({
      model: "gpt-4o-mini-2024-07-18",
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: analysisPrompt
        }
      ],
      temperature: 0.3,
      response_format: { type: "json_object" }
    });

    const responseText = analysis.choices[0].message.content;
    
    try {
      const parsedAnalysis = JSON.parse(responseText);
      
      // Validate and ensure coverage
      const timestamps = [
        ...parsedAnalysis.mainTopics.map(t => t.timestamp),
        ...parsedAnalysis.timeline.map(t => t.time)
      ].map(t => {
        const parts = t.split(':').map(Number);
        return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
      }).sort((a, b) => a - b);

      // Check for gaps larger than 3 minutes
      const hasLargeGaps = timestamps.some((time, i) => {
        if (i === 0) return time > 180; // Check start
        return (time - timestamps[i-1]) > 180; // Check gaps
      });

      if (hasLargeGaps) {
        console.warn('Warning: Analysis contains gaps larger than 3 minutes');
      }

      return parsedAnalysis;
    } catch (parseError) {
      console.error('JSON Parse Error:', parseError);
      console.error('Response Text:', responseText);
      
      // Create a structured fallback analysis
      return {
        summary: `${metadata.title} - ${formatDuration(metadata.duration)} video analysis`,
        mainTopics: chunks.filter((_, i) => i % 3 === 0).map((chunk, i) => ({
          topic: `Section ${i + 1}`,
          timestamp: formatDuration(chunk.startTime),
          description: chunk.text.slice(0, 100) + '...'
        })),
        keyConcepts: [
          {
            concept: "Video Content",
            definition: "Main content of the video"
          }
        ],
        timeline: chunks.filter((_, i) => i % 2 === 0).map(chunk => ({
          time: formatDuration(chunk.startTime),
          event: chunk.text.slice(0, 50) + '...'
        }))
      };
    }
  } catch (error) {
    console.error('Analysis Error:', error);
    throw error;
  }
}

async function fetchVideoTranscript(videoId) {
  try {
    console.log('Attempting to fetch transcript for video:', videoId);

    // First, try to get available transcript list
    let transcriptList;
    try {
      transcriptList = await YoutubeTranscript.listTranscripts(videoId);
      console.log('Available transcripts:', transcriptList);
    } catch (error) {
      console.log('Failed to get transcript list:', error);
      transcriptList = null;
    }

    let transcript = null;
    let detectedLanguage = 'en';
    let captionType = 'auto';

    // If we have transcript list, try to get manual captions first
    if (transcriptList) {
      try {
        // Try to get manual captions in preferred languages
        const manualTranscript = await transcriptList.findManualTranscript(['ms', 'en']);
        if (manualTranscript) {
          transcript = await manualTranscript.fetch();
          captionType = 'manual';
          detectedLanguage = manualTranscript.language_code;
          console.log('Found manual transcript in language:', detectedLanguage);
        }
      } catch (error) {
        console.log('Failed to get manual transcript:', error);
      }

      // If no manual transcript, try auto-generated
      if (!transcript) {
        try {
          const autoTranscript = await transcriptList.findGeneratedTranscript(['ms', 'en']);
          if (autoTranscript) {
            transcript = await autoTranscript.fetch();
            captionType = 'auto';
            detectedLanguage = autoTranscript.language_code;
            console.log('Found auto-generated transcript in language:', detectedLanguage);
          }
        } catch (error) {
          console.log('Failed to get auto-generated transcript:', error);
        }
      }
    }

    // If transcript list method failed, try direct fetching
    if (!transcript) {
      console.log('Trying direct transcript fetch methods...');
      const options = [
        { lang: 'ms' },
        { lang: 'en' },
        { lang: 'ms', useAutoGenerated: true },
        { lang: 'en', useAutoGenerated: true },
        { useAutoGenerated: true }
      ];

      for (const opt of options) {
        try {
          console.log('Trying with options:', opt);
          const result = await YoutubeTranscript.fetchTranscript(videoId, opt);
          
          if (result && Array.isArray(result) && result.length > 0) {
            transcript = result;
            detectedLanguage = opt.lang || 'en';
            captionType = opt.useAutoGenerated ? 'auto' : 'manual';
            console.log('Successfully fetched transcript with options:', opt);
            break;
          }
        } catch (error) {
          console.log('Attempt failed with options:', opt, 'Error:', error.message);
        }
      }
    }

    if (!transcript) {
      throw new Error('No captions available. The video might not have any captions enabled.');
    }

    // Post-process the transcript
    const processedTranscript = transcript
      .map(item => ({
        ...item,
        text: item.text
          .replace(/(\r\n|\n|\r)/gm, " ")
          .replace(/\s+/g, " ")
          .trim()
      }))
      .filter(item => item.text.length > 0);

    console.log('Successfully processed transcript:', {
      type: captionType,
      language: detectedLanguage,
      segments: processedTranscript.length
    });
    
    return { 
      transcript: processedTranscript, 
      language: detectedLanguage,
      captionType 
    };
  } catch (error) {
    console.error('Final transcript fetch error:', error);
    throw new Error(
      `Failed to fetch transcript: ${error.message}. ` +
      'Please try another video or ensure the video has captions enabled.'
    );
  }
}

app.post('/api/transcript', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const videoId = extractVideoId(url);
    
    if (!videoId) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    // Return cached data if available
    if (transcriptCache.has(videoId)) {
      const cachedData = transcriptCache.get(videoId);
      const analysis = videoAnalysisCache.get(videoId);
      return res.json({
        success: true,
        message: 'Transcript loaded from cache',
        metadata: cachedData.metadata,
        transcript: cachedData.transcript,
        analysis,
        language: cachedData.language,
        captionType: cachedData.captionType
      });
    }

    try {
      const { transcript: transcriptResult, language, captionType } = await fetchVideoTranscript(videoId);

      // Process transcript and get total duration
      const { chunks, totalDuration } = chunkTranscript(transcriptResult);

      // Try to fetch video title using oEmbed
      let videoTitle = 'YouTube Video';
      try {
        const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
        const oembedResponse = await fetch(oembedUrl);
        const oembedData = await oembedResponse.json();
        videoTitle = oembedData.title || videoTitle;
      } catch (e) {
        console.log('Failed to fetch video title:', e);
      }

      const metadata = {
        title: videoTitle,
        duration: totalDuration,
        author: 'YouTube Creator'
      };

      // Analyze the transcript with detected language
      const analysis = await analyzeTranscript(transcriptResult, metadata, language);

      // Store processed data
      const processedData = {
        metadata,
        transcript: transcriptResult,
        chunks,
        language,
        captionType
      };

      transcriptCache.set(videoId, processedData);
      videoAnalysisCache.set(videoId, analysis);

      return res.json({
        success: true,
        message: `Transcript loaded successfully (${captionType === 'auto' ? 'Auto-generated' : 'Manual'} captions)`,
        metadata,
        transcript: transcriptResult,
        analysis,
        language,
        captionType
      });
    } catch (transcriptError) {
      console.error('Transcript error:', transcriptError);
      throw new Error(
        'Failed to load video captions. ' +
        'Please ensure the video has either manual or auto-generated captions available.'
      );
    }
  } catch (error) {
    console.error('API error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { message, videoId } = req.body;
    const cachedData = transcriptCache.get(videoId);
    const analysis = videoAnalysisCache.get(videoId);

    if (!cachedData || !analysis) {
      return res.status(400).json({ error: 'Transcript not found. Please load the video first.' });
    }

    const { metadata, chunks, language } = cachedData;
    
    // Get relevant chunks based on the query
    const relevantChunks = getRelevantChunks(chunks, message, analysis);
    
    // Create optimized context with detected language
    const contextPrompt = createChatContext(message, metadata, analysis, relevantChunks, language);

    const systemPrompt = language === 'ms'
      ? `Anda adalah pembantu yang membantu menjawab soalan tentang video YouTube.
         Gunakan analisis video dan bahagian transkrip yang disediakan.
         Sentiasa rujuk timestamp tertentu apabila membincangkan bahagian video.
         Jika maklumat tidak ada dalam konteks yang diberikan, nyatakan.
         Format timestamp sebagai [MM:SS] atau [HH:MM:SS] untuk video yang lebih panjang.
         Pastikan jawapan fokus dan ringkas sambil informatif.`
      : `You are a helpful assistant that answers questions about YouTube videos.
         Use the provided video analysis and relevant transcript sections.
         Always reference specific timestamps when discussing parts of the video.
         If the information isn't in the provided context, say so.
         Format timestamps as [MM:SS] or [HH:MM:SS] for longer videos.
         Keep responses focused and concise while being informative.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini-2024-07-18",
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        { role: "user", content: contextPrompt }
      ],
      temperature: 0.7,
      max_tokens: 1000
    });

    res.json({ response: completion.choices[0].message.content });
  } catch (error) {
    res.status(500).json({ error: 'Failed to process chat message: ' + error.message });
  }
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 