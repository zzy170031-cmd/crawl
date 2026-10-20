"""Local speech transcription; does not claim to understand music or sound effects."""
import argparse, datetime, hashlib, json, os, pathlib, re, time
os.environ.setdefault('HF_HUB_OFFLINE', '1')
os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')
from faster_whisper import WhisperModel
import av
import numpy as np

parser=argparse.ArgumentParser()
parser.add_argument('source_id')
parser.add_argument('--model',default=os.environ.get('CRAWL_WHISPER_MODEL','small'))
args=parser.parse_args()
if not ((args.source_id.isdigit() and 10<=len(args.source_id)<=25)
        or re.fullmatch(r'media_[a-f0-9]{64}', args.source_id)):
    raise SystemExit('Expected concrete video ID or content-addressed media artifact ID')
folder=pathlib.Path(os.environ.get('CRAWL_DATA_DIR',str(pathlib.Path(__file__).resolve().parents[1]/'data'))).resolve()/'media'/args.source_id
audio=folder/'audio.webm'
coverage=json.loads((folder/'audio.json').read_text(encoding='utf-8'))
if coverage['source_id']!=args.source_id or coverage['end']<coverage['duration']-.5:
    raise SystemExit('Audio identity or coverage incomplete')
started=time.monotonic()
print('Loading local speech model: '+args.model,flush=True)
model=WhisperModel(args.model,device='cpu',compute_type='int8',cpu_threads=4,
                   download_root=os.environ.get('CRAWL_WHISPER_CACHE') or None, local_files_only=True)
print('Speech model loaded',flush=True)
resampler=av.AudioResampler(format='fltp',layout='mono',rate=16000)
chunks=[]
with av.open(str(audio)) as container:
    for frame in container.decode(audio=0):
        chunks.extend(f.to_ndarray().ravel() for f in resampler.resample(frame))
    chunks.extend(f.to_ndarray().ravel() for f in resampler.resample(None))
if not chunks:raise SystemExit('No decodable audio samples')
waveform=np.concatenate(chunks).astype(np.float32)
print(f'Decoded {len(waveform)/16000:.2f}s of audio',flush=True)
segments,info=model.transcribe(waveform,language='zh',beam_size=5,
                              vad_filter=False,condition_on_previous_text=False)
rows=[]
for segment in segments:
    rows.append({'start':segment.start,'end':segment.end,'text':segment.text,
                 'avg_logprob':segment.avg_logprob,'no_speech_prob':segment.no_speech_prob})
    print(f'Transcribed segment ending at {segment.end:.1f}s',flush=True)
output={'source_id':args.source_id,'model':args.model,'engine':'faster-whisper',
        'status':'machine_transcript_pending_review','language':info.language,'vad_filter':False,
        'audio_sha256':hashlib.sha256(audio.read_bytes()).hexdigest(),
        'audio_duration':info.duration,'recording_coverage':coverage,'segments':rows,
        'elapsed_seconds':round(time.monotonic()-started,2),
        'created_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'limitations':['Automatic speech transcription; names and unclear speech need checking.',
                       'Music, sound effects and speaker identities are not analyzed.']}
if not rows:output['status']='no_speech_recognized'
temp=folder/'transcript.tmp'
temp.write_text(json.dumps(output,ensure_ascii=False,indent=2),encoding='utf-8')
temp.replace(folder/'transcript.json')
print(json.dumps({'source_id':args.source_id,'status':output['status'],'segments':len(rows),'elapsed_seconds':output['elapsed_seconds']}),flush=True)
