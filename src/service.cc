#ifndef SERVICE_CC
#define SERVICE_CC

#include <node.h>
#include <nan.h>
#include <uv.h>

#include <io.h>
#include <signal.h>
#include <stdio.h>
#include <string>
#include <queue>
#include <windows.h>

#include "pthread.h"
#include "service.h"

static bool run_initialised = false;
static DWORD controls_accepted = 0;
static DWORD service_state = SERVICE_STOPPED;

static SERVICE_STATUS_HANDLE status_handle;
static pthread_mutex_t status_handle_mtx;

static bool stop_requested = false;
static pthread_mutex_t stop_requested_mtx;

static pthread_cond_t stop_service;
static pthread_mutex_t stop_service_mtx;

typedef struct {
	DWORD signal;
	DWORD event_type;
	LPVOID event_data;
} SignalData;

static std::queue<SignalData*> signals;
static pthread_mutex_t signals_mtx;

HANDLE node_thread_handle;

Nan::Callback* callback;
uv_async_t async;

static char errbuf[1024];
const char* raw_strerror (int code) {
	if (FormatMessage (FORMAT_MESSAGE_FROM_SYSTEM, 0, code, 0, errbuf,
			1024, NULL)) {
		return errbuf;
	} else {
		strcpy (errbuf, "Unknown error");
		return errbuf;
	}
}

DWORD set_status (DWORD status_code, DWORD win32_rcode, DWORD service_rcode) {
	SERVICE_STATUS status;

	memset (&status, 0, sizeof (SERVICE_STATUS));

	status.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
	status.dwCurrentState = status_code;
	status.dwControlsAccepted = SERVICE_ACCEPT_SHUTDOWN | SERVICE_ACCEPT_STOP | controls_accepted;
	status.dwWin32ExitCode = (service_rcode
			? ERROR_SERVICE_SPECIFIC_ERROR
			: win32_rcode);
	status.dwServiceSpecificExitCode = service_rcode;
	status.dwCheckPoint = 0;
	status.dwWaitHint = 10000;

	pthread_mutex_lock (&status_handle_mtx);
	service_state = status_code;
	SetServiceStatus (status_handle, &status);
	pthread_mutex_unlock (&status_handle_mtx);

	return 0;
}

void invoke_callback(uv_async_t* handle) {
	Nan::HandleScope scope;
	Isolate* isolate = Isolate::GetCurrent();
	
	pthread_mutex_lock(&signals_mtx);

	while (!signals.empty()) {
		SignalData* data = signals.front();
		
		Local<Value> argv[] = {
			Number::New(isolate, data->signal),
			Number::New(isolate, data->event_type),
			Number::New(isolate, (UINT)data->event_data)
		};
		callback->Call(3, argv);

		if (data->event_data) {
			free(data->event_data);
		}
		free(data);
		signals.pop();

	}

	pthread_mutex_unlock(&signals_mtx);
}

void send_control(DWORD control, DWORD event_type, LPVOID event_data) {
	// The signals are put in a queue because uv_async_send doesn't guarantee to invoke
	// this function every time.
	pthread_mutex_lock(&signals_mtx);

	SignalData *data = (SignalData*)malloc(sizeof(SignalData));
	data->signal = control;
	data->event_type = event_type;
	data->event_data = NULL;
	
	signals.push(data);
	pthread_mutex_unlock(&signals_mtx);
	// Invoke the call back on the main thread
	uv_async_send(&async);
}

DWORD WINAPI handler (DWORD signal, DWORD event_type, LPVOID event_data, LPVOID context) {

	switch (signal) {
		case (SERVICE_CONTROL_STOP):
		case (SERVICE_CONTROL_SHUTDOWN):
			set_status(SERVICE_STOP_PENDING, NO_ERROR, 0);
			pthread_mutex_lock(&stop_requested_mtx);
			stop_requested = true;
			pthread_mutex_unlock(&stop_requested_mtx);
			break;
		case (SERVICE_CONTROL_PAUSE):
			set_status(SERVICE_PAUSE_PENDING, NO_ERROR, 0);
			break;
		case (SERVICE_CONTROL_CONTINUE):
			set_status(SERVICE_CONTINUE_PENDING, NO_ERROR, 0);
			break;
		default:
			break;
	}

	send_control(signal, event_type, event_data);

	return NO_ERROR;
}

VOID WINAPI run (DWORD argc, LPTSTR *argv) {
	if (! (status_handle = RegisterServiceCtrlHandlerEx ("", handler, NULL))) {
		set_status (SERVICE_STOPPED, GetLastError (), 0);
		return;
	}

	set_status (SERVICE_RUNNING, NO_ERROR, 0);

	send_control(0, 0, 0);

	pthread_mutex_lock (&stop_service_mtx);
	pthread_cond_wait (&stop_service, &stop_service_mtx);
	pthread_mutex_unlock (&stop_service_mtx);
}

DWORD __stdcall run_thread (LPVOID param) {
	SERVICE_TABLE_ENTRY table[] = {{"", run}, {0, }};

	if (StartServiceCtrlDispatcher (table)) {
		while (1) {
			DWORD status;
			BOOL rcode = GetExitCodeThread (node_thread_handle, &status);

			if (! rcode)
				break;

			if (status != STILL_ACTIVE)
				break;
		}
	} else {
		while (1) {
			Sleep(60000);
		}
	}

	ExitThread (0);
}

namespace service {

void InitAll (Handle<Object> exports) {
	pthread_mutex_init(&status_handle_mtx, NULL);
	pthread_mutex_init(&stop_requested_mtx, NULL);
	pthread_mutex_init(&stop_service_mtx, NULL);
	pthread_mutex_init(&signals_mtx, NULL);

	pthread_cond_init(&stop_service, NULL);

	exports->Set(Nan::New("add").ToLocalChecked(),
			Nan::GetFunction(Nan::New<FunctionTemplate>(Add)).ToLocalChecked());

	exports->Set(Nan::New("isStopRequested").ToLocalChecked(),
			Nan::GetFunction(Nan::New<FunctionTemplate>(IsStopRequested)).ToLocalChecked());
	
	exports->Set(Nan::New("remove").ToLocalChecked(),
			Nan::GetFunction(Nan::New<FunctionTemplate>(Remove)).ToLocalChecked());
	
	exports->Set(Nan::New("run").ToLocalChecked(),
			Nan::GetFunction(Nan::New<FunctionTemplate>(Run)).ToLocalChecked());
	
	exports->Set(Nan::New("stop").ToLocalChecked(),
		Nan::GetFunction(Nan::New<FunctionTemplate>(Stop)).ToLocalChecked());

	exports->Set(Nan::New("setState").ToLocalChecked(),
		Nan::GetFunction(Nan::New<FunctionTemplate>(SetState)).ToLocalChecked());

	exports->Set(Nan::New("getState").ToLocalChecked(),
		Nan::GetFunction(Nan::New<FunctionTemplate>(GetState)).ToLocalChecked());

	exports->Set(Nan::New("setControlsAccepted").ToLocalChecked(),
		Nan::GetFunction(Nan::New<FunctionTemplate>(SetControlsAccepted)).ToLocalChecked());
}

NODE_MODULE(service, InitAll)

NAN_METHOD(Add) {
	Nan::HandleScope scope;
	
	if (info.Length() < 3) {
		Nan::ThrowError("Two arguments are required");
		return;
	}
	
	if (! info[0]->IsString()) {
		Nan::ThrowTypeError("Name argument must be a string");
		return;
	}
	
	Nan::Utf8String name(info[0]);

	if (! info[1]->IsString ()) {
		Nan::ThrowTypeError("Display name argument must be a string");
		return;
	}
	
	Nan::Utf8String display_name(info[1]);

	if (! info[2]->IsString ()) {
		Nan::ThrowTypeError("Name argument must be a string");
		return;
	}
	
	Nan::Utf8String path(info[2]);

	std::string username;
	std::string password;

	if (info.Length() > 3) {
		if (info[3]->IsString ()) {
			Nan::Utf8String tmp_username(info[3]);
			username = *tmp_username;
		}
	
		if (info.Length() > 4) {
			if (info[4]->IsString ()) {
				Nan::Utf8String tmp_password(info[4]);
				password = *tmp_password;
			}
		}
	}

	SC_HANDLE scm_handle = OpenSCManager (0, SERVICES_ACTIVE_DATABASE,
			SC_MANAGER_ALL_ACCESS);
	if (! scm_handle) {
		std::string message ("OpenSCManager() failed: ");
		message += raw_strerror (GetLastError ());
		Nan::ThrowError(message.c_str());
		return;
	}

	const char* pusername = username.length() ? username.c_str() : NULL;
	const char* ppassword = password.length() ? password.c_str() : NULL;

	SC_HANDLE svc_handle = CreateService (scm_handle, *name, *display_name,
			SERVICE_ALL_ACCESS, SERVICE_WIN32_OWN_PROCESS, SERVICE_AUTO_START,
			SERVICE_ERROR_NORMAL, *path, 0, 0, 0, pusername, ppassword);

	if (! svc_handle) {
		std::string message ("CreateService() failed: ");
		message += raw_strerror (GetLastError ());
		CloseServiceHandle (scm_handle);
		Nan::ThrowError(message.c_str());
		return;
	}

	CloseServiceHandle (svc_handle);
	CloseServiceHandle (scm_handle);

	info.GetReturnValue().Set(info.This());
}

NAN_METHOD(IsStopRequested) {
	Nan::HandleScope scope;

	pthread_mutex_lock (&stop_requested_mtx);
	bool requested = stop_requested ? true : false;
	stop_requested = false;
	pthread_mutex_unlock (&stop_requested_mtx);
	
	info.GetReturnValue().Set(requested);
}

NAN_METHOD(Remove) {
	Nan::HandleScope scope;
	
	if (info.Length () < 1) {
		Nan::ThrowError("One argument is required");
		return;
	}
	
	if (! info[0]->IsString ()) {
		Nan::ThrowTypeError("Name argument must be a string");
		return;
	}
	
	Nan::Utf8String name(info[0]);

	SC_HANDLE scm_handle = OpenSCManager (0, SERVICES_ACTIVE_DATABASE,
			SC_MANAGER_ALL_ACCESS);
	if (! scm_handle) {
		std::string message ("OpenSCManager() failed: ");
		message += raw_strerror (GetLastError ());
		Nan::ThrowError(message.c_str());
		return;
	}

	SC_HANDLE svc_handle = OpenService (scm_handle, *name, SERVICE_ALL_ACCESS);
	if (! svc_handle) {
		std::string message ("OpenService() failed: ");
		message += raw_strerror (GetLastError ());
		CloseServiceHandle (scm_handle);
		Nan::ThrowError(message.c_str());
		return;
	}

	if (! DeleteService (svc_handle)) {
		std::string message ("DeleteService() failed: ");
		message += raw_strerror (GetLastError ());
		CloseServiceHandle (svc_handle);
		CloseServiceHandle (scm_handle);
		Nan::ThrowError(message.c_str());
		return;
	}

	CloseServiceHandle (svc_handle);
	CloseServiceHandle (scm_handle);

	info.GetReturnValue().Set(info.This());
}

NAN_METHOD(Run) {
	Nan::HandleScope scope;

	if (run_initialised) {
		info.GetReturnValue().Set(info.This());
		return;
	}

	if (info.Length() > 0) {
		if (! info[0]->IsFunction()) {
			Nan::ThrowTypeError("Callback argument must be a function");
			return;
		}
		callback = new Nan::Callback(info[0].As<Function>());
		uv_loop_t *loop = uv_default_loop();
		uv_async_init(loop, &async, invoke_callback);
	}

	node_thread_handle = GetCurrentThread ();

	HANDLE handle = CreateThread (NULL, 0, run_thread, NULL, 0, NULL);
	if (! handle) {
		std::string message ("CreateThread() failed: ");
		message += raw_strerror (GetLastError ());
		Nan::ThrowError(message.c_str());
		return;
	} else {
		CloseHandle (handle);
	}
	
	run_initialised = true;

	info.GetReturnValue().Set(info.This());
}

NAN_METHOD(Stop) {
	Nan::HandleScope scope;
	
	if (! run_initialised) {
		info.GetReturnValue().Set(info.This());
		return;
	}
	
	int rcode = 0;
	
	if (info.Length () > 1) {
		if (! info[0]->IsUint32 ()) {
			Nan::ThrowTypeError("Name argument must be a string");
			return;
		}
		
		rcode = info[0]->ToUint32()->Value();
	}
	
	set_status (SERVICE_STOP_PENDING, NO_ERROR, 0);
	
	pthread_cond_signal (&stop_service);
	
	set_status (SERVICE_STOPPED, NO_ERROR, rcode);

	uv_close((uv_handle_t*)&async, NULL);

	info.GetReturnValue().Set(info.This());
}

NAN_METHOD(SetState) {
	Nan::HandleScope scope;

	if (info.Length() > 0) {
		if (!info[0]->IsNumber()) {
			Nan::ThrowTypeError("First argument must be a number");
			return;
		}

		DWORD new_state = info[0]->Uint32Value();
		set_status(new_state, NO_ERROR, 0);
	}

	info.GetReturnValue().Set(info.This());
}

NAN_METHOD(GetState) {
	Nan::HandleScope scope;
	Isolate* isolate = Isolate::GetCurrent();

	pthread_mutex_lock(&status_handle_mtx);
	Local<Number> stateNumber = Number::New(isolate, service_state);
	pthread_mutex_unlock(&status_handle_mtx);

	info.GetReturnValue().Set(stateNumber);
}

NAN_METHOD(SetControlsAccepted) {
	Nan::HandleScope scope;

	if (info.Length() > 0) {
		if (!info[0]->IsNumber()) {
			Nan::ThrowTypeError("First argument must be a number");
			return;
		}

		controls_accepted = info[0]->Uint32Value();
		set_status(SERVICE_RUNNING, NO_ERROR, 0);
	}

	info.GetReturnValue().Set(info.This());
}

}; /* namespace service */

#endif /* SERVICE_CC */
