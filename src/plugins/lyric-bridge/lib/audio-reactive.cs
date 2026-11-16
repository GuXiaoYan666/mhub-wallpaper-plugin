using System;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

namespace LyricBridgeAudio {
  // Only compact spectral summaries leave this process. No audio is saved.
  public sealed class Spectrum {
    const int N = 2048;
    readonly double[] ring = new double[N], real = new double[N], imag = new double[N], window = new double[N];
    int cursor, count, serial;
    double bassMean, previousBass, lastBeatTime = -1000, lastBeat;
    public Spectrum() { for(int i=0;i<N;i++) window[i]=.5-.5*Math.Cos(2*Math.PI*i/(N-1)); }
    public void Add(double sample) { ring[cursor]=Double.IsNaN(sample)||Double.IsInfinity(sample)?0:Math.Max(-1,Math.Min(1,sample));cursor=(cursor+1)%N;count=Math.Min(N,count+1); }
    static double Unit(double x) { return Math.Max(0,Math.Min(1,x)); }
    static double Level(double x) { return x<.00005?0:Unit((20*Math.Log10(x)+58)/48); }
    public double[] Read(int rate, double time) {
      double rms=0;
      for(int i=0;i<N;i++){double s=ring[(cursor+i)%N];rms+=s*s;real[i]=s*window[i];imag[i]=0;}
      for(int i=1,j=0;i<N;i++){int bit=N>>1;for(; (j&bit)!=0;bit>>=1)j^=bit;j^=bit;if(i<j){double v=real[i];real[i]=real[j];real[j]=v;}}
      for(int len=2;len<=N;len<<=1){double a=-2*Math.PI/len,cr=Math.Cos(a),ci=Math.Sin(a);for(int i=0;i<N;i+=len){double wr=1,wi=0;for(int j=0;j<len/2;j++){int p=i+j,q=p+len/2;double vr=real[q]*wr-imag[q]*wi,vi=real[q]*wi+imag[q]*wr;real[q]=real[p]-vr;imag[q]=imag[p]-vi;real[p]+=vr;imag[p]+=vi;double nr=wr*cr-wi*ci;wi=wr*ci+wi*cr;wr=nr;}}}
      double lo=0,mid=0,hi=0;
      for(int k=1;k<N/2;k++){double hz=(double)k*rate/N,power=(real[k]*real[k]+imag[k]*imag[k])*16/(N*N);if(hz>=35&&hz<180)lo+=power;else if(hz<2500&&hz>=180)mid+=power;else if(hz>=2500&&hz<16000)hi+=power;}
      double bass=Level(Math.Sqrt(lo)),middle=Level(Math.Sqrt(mid)),high=Level(Math.Sqrt(hi)),energy=Level(Math.Sqrt(rms/N));
      double flux=Math.Max(0,bass-previousBass);previousBass=bass;
      if(count==N && bass>.12 && bass>bassMean+.045 && flux>.035 && time-lastBeatTime>.16){serial++;lastBeatTime=time;lastBeat=Unit(.4+flux*3+(bass-bassMean)*1.5);}
      bassMean=bassMean*.94+bass*.06;
      double beat=lastBeat*Math.Exp(-Math.Max(0,time-lastBeatTime)/.19);
      return new double[]{energy,bass,middle,high,beat,serial};
    }
  }

  [ComImport,Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class Enumerator {}
  [ComImport,Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IDevices {
    [PreserveSig]int EnumAudioEndpoints(int flow,int state,out IntPtr devices);
    [PreserveSig]int GetDefaultAudioEndpoint(int flow,int role,out IDevice device);
    [PreserveSig]int GetDevice([MarshalAs(UnmanagedType.LPWStr)]string id,out IDevice device);
    [PreserveSig]int RegisterEndpointNotificationCallback(IntPtr callback);
    [PreserveSig]int UnregisterEndpointNotificationCallback(IntPtr callback);
  }
  [ComImport,Guid("D666063F-1587-4E43-81F1-B948E807363F"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IDevice {
    [PreserveSig]int Activate(ref Guid iid,int context,IntPtr parameters,[MarshalAs(UnmanagedType.IUnknown)]out object value);
    [PreserveSig]int OpenPropertyStore(int mode,out IntPtr properties);
    [PreserveSig]int GetId([MarshalAs(UnmanagedType.LPWStr)]out string id);
    [PreserveSig]int GetState(out int state);
  }
  [ComImport,Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IClient {
    [PreserveSig]int Initialize(int mode,uint flags,long duration,long period,IntPtr format,ref Guid session);
    [PreserveSig]int GetBufferSize(out uint frames);
    [PreserveSig]int GetStreamLatency(out long latency);
    [PreserveSig]int GetCurrentPadding(out uint padding);
    [PreserveSig]int IsFormatSupported(int mode,IntPtr format,out IntPtr closest);
    [PreserveSig]int GetMixFormat(out IntPtr format);
    [PreserveSig]int GetDevicePeriod(out long standard,out long minimum);
    [PreserveSig]int Start(); [PreserveSig]int Stop(); [PreserveSig]int Reset();
    [PreserveSig]int SetEventHandle(IntPtr handle);
    [PreserveSig]int GetService(ref Guid iid,[MarshalAs(UnmanagedType.IUnknown)]out object service);
  }
  [ComImport,Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface ICapture {
    [PreserveSig]int GetBuffer(out IntPtr data,out uint frames,out uint flags,out ulong position,out ulong timestamp);
    [PreserveSig]int ReleaseBuffer(uint frames);
    [PreserveSig]int GetNextPacketSize(out uint frames);
  }
  public static class Loopback {
    static void Check(int hr) { if(hr<0)Marshal.ThrowExceptionForHR(hr); }
    static void Release(object value){if(value!=null&&Marshal.IsComObject(value))Marshal.ReleaseComObject(value);}
    static string Number(double v){return v.ToString("0.0000",CultureInfo.InvariantCulture);}
    public static void Run(int parentId,int seconds) {
      IDevices devices=null;IDevice device=null;IClient client=null;ICapture capture=null;IntPtr format=IntPtr.Zero;
      try {
        devices=(IDevices)new Enumerator();Check(devices.GetDefaultAudioEndpoint(0,1,out device));
        string endpoint;Check(device.GetId(out endpoint));
        Guid clientId=typeof(IClient).GUID;object raw;Check(device.Activate(ref clientId,23,IntPtr.Zero,out raw));client=(IClient)raw;
        Check(client.GetMixFormat(out format));
        int tag=(ushort)Marshal.ReadInt16(format,0),channels=(ushort)Marshal.ReadInt16(format,2),rate=Marshal.ReadInt32(format,4),align=(ushort)Marshal.ReadInt16(format,12),bits=(ushort)Marshal.ReadInt16(format,14);
        bool floating=tag==3 || tag==65534&&Marshal.ReadInt32(format,24)==3;
        if(channels<1||channels>32||rate<8000||rate>384000||align!=channels*(bits/8)||!(floating&&bits==32||!floating&&(bits==16||bits==24||bits==32)))throw new InvalidOperationException("Unsupported output mix format");
        Guid session=Guid.Empty;Check(client.Initialize(0,0x20000,1000000,0,format,ref session));
        Guid captureId=typeof(ICapture).GUID;Check(client.GetService(ref captureId,out raw));capture=(ICapture)raw;Check(client.Start());
        var fft=new Spectrum();var clock=Stopwatch.StartNew();byte[] bytes=new byte[0];double next=0,lastPacket=0,nextParent=0,nextEndpoint=2;
        Console.WriteLine("{\"t\":\"ready\",\"source\":\"default-output\",\"sampleRate\":"+rate+"}");
        while(seconds<=0||clock.Elapsed.TotalSeconds<seconds){
          double time=clock.Elapsed.TotalSeconds;
          if(time>=nextParent){nextParent=time+1;try{using(var parent=Process.GetProcessById(parentId)){if(parent.HasExited)break;}}catch{break;}}
          if(time>=nextEndpoint){nextEndpoint=time+2;IDevice current=null;try{Check(devices.GetDefaultAudioEndpoint(0,1,out current));string id;Check(current.GetId(out id));if(id!=endpoint)throw new InvalidOperationException("Default output changed");}finally{Release(current);}}
          uint available;Check(capture.GetNextPacketSize(out available));
          while(available>0){
            IntPtr data;uint frames,flags;ulong position,timestamp;Check(capture.GetBuffer(out data,out frames,out flags,out position,out timestamp));
            try{
              int size=checked((int)frames*align);if(bytes.Length<size)bytes=new byte[size];bool silent=(flags&2)!=0;
              if(!silent)Marshal.Copy(data,bytes,0,size);
              for(int f=0;f<frames;f++){double sum=0;for(int c=0;c<channels;c++){int o=f*align+c*(bits/8);double sample=0;if(!silent){if(floating)sample=BitConverter.ToSingle(bytes,o);else if(bits==16)sample=BitConverter.ToInt16(bytes,o)/32768.0;else if(bits==32)sample=BitConverter.ToInt32(bytes,o)/2147483648.0;else{int v=bytes[o]|bytes[o+1]<<8|bytes[o+2]<<16;if((v&0x800000)!=0)v|=unchecked((int)0xff000000);sample=v/8388608.0;}}sum+=sample;}fft.Add(sum/channels);}
              lastPacket=time;
            }finally{Check(capture.ReleaseBuffer(frames));}
            Check(capture.GetNextPacketSize(out available));
          }
          if(time>=next){next=time+.04;if(time-lastPacket>.12)for(int i=0;i<2048;i++)fft.Add(0);double[] s=fft.Read(rate,time);
            long at=(long)(DateTime.UtcNow-new DateTime(1970,1,1)).TotalMilliseconds;
            Console.WriteLine("{\"t\":\"spectrum\",\"at\":"+at+",\"energy\":"+Number(s[0])+",\"bass\":"+Number(s[1])+",\"mid\":"+Number(s[2])+",\"treble\":"+Number(s[3])+",\"beat\":"+Number(s[4])+",\"serial\":"+(int)s[5]+"}");
          }
          Thread.Sleep(6);
        }
      }finally{if(client!=null)try{client.Stop();}catch{}if(format!=IntPtr.Zero)Marshal.FreeCoTaskMem(format);Release(capture);Release(client);Release(device);Release(devices);}
    }
  }
}
