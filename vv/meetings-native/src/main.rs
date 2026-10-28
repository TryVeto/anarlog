use anlg_audio_actual::{AudioInput, CaptureConfig};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::io::Write;
use tokio::io::{AsyncBufReadExt, BufReader};

fn emit(value: Value) -> Result<(), Box<dyn std::error::Error>> {
    println!("{value}");
    std::io::stdout().flush()?;
    Ok(())
}

fn samples(path: &str) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
    let mut reader = hound::WavReader::open(path)?;
    let spec = reader.spec();
    if spec.sample_rate != 16000 || spec.channels != 1 || spec.bits_per_sample != 16 {
        return Err("Expected mono 16 kHz, 16-bit PCM WAV".into());
    }
    if reader.duration() > 16000 * 60 * 240 {
        return Err("Audio exceeds the four-hour processing limit".into());
    }
    Ok(reader
        .samples::<i16>()
        .map(|sample| sample.map(|s| s as f32 / 32768.0))
        .collect::<Result<_, _>>()?)
}

fn capture(mode: &str) -> Result<anlg_audio_actual::CaptureStream, Box<dyn std::error::Error>> {
    match mode {
        "microphone" => Ok(AudioInput::from_mic_capture(None, 16000, 1600)?),
        "system" => Ok(AudioInput::from_mic_and_speaker(CaptureConfig {
            sample_rate: 16000,
            chunk_size: 1600,
            mic_device: None,
            enable_aec: false,
        })?),
        _ => Err("Capture source must be microphone or system".into()),
    }
}

async fn run(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    match args.first().map(String::as_str) {
        Some("capabilities") => emit(json!({"version":1,"engine":"Anarlog community","transcription":"whisper-local","capture":true,"local":true})),
        Some("transcribe") if args.len() == 3 => {
            let audio = samples(&args[2])?;
            let model = anlg_whisper_local::LoadedWhisper::builder().model_path(&args[1]).build()?;
            let mut session = model.session(Vec::new())?;
            let mut text = Vec::new();
            // Keep inference bounded while retaining the model's context across chunks.
            for (index, chunk) in audio.chunks(16000 * 30).enumerate() {
                for segment in session.transcribe(chunk)? {
                    let part = segment.text().trim();
                    if part.is_empty() { continue; }
                    text.push(part.to_string());
                    emit(json!({"type":"transcript","text":part,"chunkStart":index * 30,"chunkEnd":index as f64 * 30.0 + chunk.len() as f64 / 16000.0}))?;
                }
            }
            emit(json!({"type":"complete","text":text.join(" "),"duration":audio.len() as f64 / 16000.0,"engine":"Anarlog whisper-local","local":true}))
        }
        Some("record") if args.len() == 4 && !args[3].trim().is_empty() => {
            let mode = &args[2];
            let mut stream = Some(capture(mode)?);
            let spec = hound::WavSpec { channels: 2, sample_rate: 16000, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
            let mut writer = hound::WavWriter::create(&args[1], spec)?;
            let mut lines = BufReader::new(tokio::io::stdin()).lines();
            let mut frames = 0u64;
            emit(json!({"type":"recording","consent":args[3],"source":mode}))?;
            loop {
                tokio::select! {
                    line = lines.next_line() => {
                        let Some(line) = line? else { break; };
                        let command: Value = serde_json::from_str(&line)?;
                        match command["action"].as_str() {
                            Some("stop") => break,
                            Some("pause") => { stream = None; writer.flush()?; emit(json!({"type":"paused","duration":frames as f64 / 16000.0}))?; }
                            Some("resume") if command["consent"].as_str().is_some_and(|value| !value.trim().is_empty()) => { stream = Some(capture(mode)?); emit(json!({"type":"recording","consent":command["consent"]}))?; }
                            _ => return Err("Unknown action or missing renewed consent".into()),
                        }
                    }
                    frame = async { match &mut stream { Some(stream) => stream.next().await, None => std::future::pending().await } } => {
                        let Some(frame) = frame else { return Err("Audio source ended".into()); };
                        let frame = frame?;
                        let count = frame.raw_mic.len().max(frame.raw_speaker.len());
                        for index in 0..count {
                            for sample in [frame.raw_mic.get(index), frame.raw_speaker.get(index)] {
                                writer.write_sample((sample.copied().unwrap_or(0.0).clamp(-1.0,1.0) * 32767.0) as i16)?;
                            }
                        }
                        frames += count as u64;
                        writer.flush()?;
                        emit(json!({"type":"progress","duration":frames as f64 / 16000.0}))?;
                    }
                }
            }
            drop(stream);
            writer.finalize()?;
            emit(json!({"type":"complete","duration":frames as f64 / 16000.0}))
        }
        _ => Err("Usage: vv-meetings-native capabilities | transcribe MODEL WAV | record WAV microphone|system CONSENT".into()),
    }
}

#[tokio::main]
async fn main() {
    if let Err(error) = run(&std::env::args().skip(1).collect::<Vec<_>>()).await {
        eprintln!("{error}");
        let _ = emit(json!({"type":"error","error":error.to_string()}));
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn capture_requires_explicit_consent_before_touching_audio_devices() {
        let args = vec![
            "record".into(),
            "unused.wav".into(),
            "microphone".into(),
            "".into(),
        ];
        assert!(
            run(&args)
                .await
                .unwrap_err()
                .to_string()
                .starts_with("Usage:")
        );
    }
}
