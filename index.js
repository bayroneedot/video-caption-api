const express = require('express');
const axios = require('axios');
const fs = require('fs');
const { exec } = require('child_process');
const path = require('path');

const app = express();
app.use(express.json());

const ASSEMBLY_API_KEY = process.env.ASSEMBLY_API_KEY;
const ASSEMBLY_ENDPOINT = 'https://api.assemblyai.com/v2';

const execPromise = (cmd) =>
  new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout || stderr);
    });
  });

async function uploadAudio(filePath) {
  const readStream = fs.createReadStream(filePath);
  const response = await axios({
    method: 'post',
    url: `${ASSEMBLY_ENDPOINT}/upload`,
    headers: {
      authorization: ASSEMBLY_API_KEY,
      'transfer-encoding': 'chunked',
    },
    data: readStream,
  });
  return response.data.upload_url;
}

async function requestTranscription(uploadUrl) {
  const response = await axios.post(
    `${ASSEMBLY_ENDPOINT}/transcript`,
    {
      audio_url: uploadUrl,
    },
    {
      headers: { authorization: ASSEMBLY_API_KEY },
    }
  );
  return response.data.id;
}

async function waitForTranscription(id) {
  while (true) {
    const res = await axios.get(`${ASSEMBLY_ENDPOINT}/transcript/${id}`, {
      headers: { authorization: ASSEMBLY_API_KEY },
    });
    if (res.data.status === 'completed') return res.data;
    else if (res.data.status === 'error') throw new Error('Transcription failed');
    await new Promise((r) => setTimeout(r, 3000)); // wait 3s then retry
  }
}

app.post('/process-video', async (req, res) => {
  try {
    const { video_url } = req.body;
    if (!video_url) return res.status(400).json({ error: 'video_url is required' });

    const videoPath = path.join(__dirname, 'video.mp4');
    const audioPath = path.join(__dirname, 'audio.wav');
    const srtPath = path.join(__dirname, 'caption.srt');
    const outputPath = path.join(__dirname, 'output.mp4');

    // Download video
    const writer = fs.createWriteStream(videoPath);
    const response = await axios({
      url: video_url,
      method: 'GET',
      responseType: 'stream',
    });
    response.data.pipe(writer);
    await new Promise((resolve) => writer.on('finish', resolve));

    // Extract audio for transcription
    await execPromise(`ffmpeg -y -i ${videoPath} -ac 1 -ar 16000 -vn ${audioPath}`);

    // Upload audio to AssemblyAI
    const uploadUrl = await uploadAudio(audioPath);

    // Request transcription
    const transcriptId = await requestTranscription(uploadUrl);

    // Wait for transcription to finish
    const transcriptData = await waitForTranscription(transcriptId);

    // Build simple .srt file (hardcoded timing here for demo, real code should parse words & timestamps)
    const srtContent = `1
00:00:00,000 --> 00:00:10,000
${transcriptData.text}
`;

    fs.writeFileSync(srtPath, srtContent);

    // Burn subtitles into video
    await execPromise(`ffmpeg -y -i ${videoPath} -vf subtitles=${srtPath} ${outputPath}`);

    // Send back the processed video file
    res.download(outputPath, 'video-with-captions.mp4');
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
