"""Spawn-importable explicit test doubles, not production inference fallbacks."""
import os
import time
import numpy as np

class FakeVision:
    def __init__(self,**config):self.delay=config.get('test_delay',0);self.tables=config.get('tables',[])
    def process_frame(self,frame,t,frame_index):
        time.sleep(self.delay)
        return {'observation':{'t':t,'frame_index':frame_index,'valid':True,'detections':[],'tracks':[],'tables':{row['id']:'absent' for row in self.tables},'surface':{}},'timing':{'inference':.001},'test_pid':os.getpid(),'pixel_sum':int(np.asarray(frame).sum())}
    def set_tables(self,tables):self.tables=tables
    def close(self):pass

class FakeSurface:
    metadata={'model':'explicit_worker_test_double','prompt_version':'test'}
    last_timing={'generation':.001}
    def __init__(self,*args,**kwargs):pass
    def assess(self,reference,current):
        assert not isinstance(reference,(str,bytes)) and not isinstance(current,(str,bytes))
        return {'outcome':'cleared_reset' if np.asarray(reference).mean()==np.asarray(current).mean() else 'not_reset','valid':True,'reason':'In-memory synthetic image pair'}
    def close(self):pass

class FakeProposal:
    def __init__(self,**config):pass
    def propose(self,frame):return [{'id':'T1','label':str(int(np.asarray(frame).sum())),'test_pid':os.getpid()}]
    def close(self):pass

class SlowProposal(FakeProposal):
    def propose(self,frame):time.sleep(10);return super().propose(frame)
