#pragma once
#include <windows.h>
#include <commctrl.h>
#include <ole2.h>
#include <uiautomation.h>
#include <atomic>

// Owner-drawn Win32 BUTTONs retain keyboard behavior, but the stock UIA proxy
// does not expose InvokePattern for BS_OWNERDRAW. Supply the standard contract.
class OverlayButtonProvider final : public IRawElementProviderSimple, public IInvokeProvider {
    std::atomic<ULONG> references_{1};
    HWND window_;

  public:
    explicit OverlayButtonProvider(HWND window) : window_(window) {}
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void **out) override {
        if (!out)
            return E_POINTER;
        *out = nullptr;
        if (id == __uuidof(IUnknown) || id == __uuidof(IRawElementProviderSimple))
            *out = static_cast<IRawElementProviderSimple *>(this);
        else if (id == __uuidof(IInvokeProvider))
            *out = static_cast<IInvokeProvider *>(this);
        else
            return E_NOINTERFACE;
        AddRef();
        return S_OK;
    }
    ULONG STDMETHODCALLTYPE AddRef() override {
        return ++references_;
    }
    ULONG STDMETHODCALLTYPE Release() override {
        auto remaining = --references_;
        if (!remaining)
            delete this;
        return remaining;
    }
    HRESULT STDMETHODCALLTYPE get_ProviderOptions(ProviderOptions *out) override {
        if (!out)
            return E_POINTER;
        *out = ProviderOptions_ServerSideProvider;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetPatternProvider(PATTERNID id, IUnknown **out) override {
        if (!out)
            return E_POINTER;
        *out = nullptr;
        if (id == UIA_InvokePatternId) {
            *out = static_cast<IInvokeProvider *>(this);
            AddRef();
        }
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetPropertyValue(PROPERTYID id, VARIANT *out) override {
        if (!out)
            return E_POINTER;
        VariantInit(out);
        if (!IsWindow(window_))
            return UIA_E_ELEMENTNOTAVAILABLE;
        switch (id) {
        case UIA_ControlTypePropertyId:
            out->vt = VT_I4;
            out->lVal = UIA_ButtonControlTypeId;
            break;
        case UIA_NamePropertyId: {
            wchar_t name[128];
            GetWindowTextW(window_, name, 128);
            out->vt = VT_BSTR;
            out->bstrVal = SysAllocString(name);
            break;
        }
        case UIA_IsEnabledPropertyId:
            out->vt = VT_BOOL;
            out->boolVal = IsWindowEnabled(window_) ? VARIANT_TRUE : VARIANT_FALSE;
            break;
        case UIA_IsKeyboardFocusablePropertyId:
        case UIA_IsControlElementPropertyId:
        case UIA_IsContentElementPropertyId:
            out->vt = VT_BOOL;
            out->boolVal = VARIANT_TRUE;
            break;
        case UIA_HasKeyboardFocusPropertyId:
            out->vt = VT_BOOL;
            out->boolVal = GetFocus() == window_ ? VARIANT_TRUE : VARIANT_FALSE;
            break;
        }
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE get_HostRawElementProvider(IRawElementProviderSimple **out) override {
        return UiaHostProviderFromHwnd(window_, out);
    }
    HRESULT STDMETHODCALLTYPE Invoke() override {
        if (!IsWindow(window_))
            return UIA_E_ELEMENTNOTAVAILABLE;
        if (!IsWindowEnabled(window_))
            return UIA_E_ELEMENTNOTENABLED;
        PostMessageW(GetParent(window_), WM_COMMAND, MAKEWPARAM(GetDlgCtrlID(window_), BN_CLICKED),
                     reinterpret_cast<LPARAM>(window_));
        return S_OK;
    }
};
inline LRESULT CALLBACK overlay_button_subclass(HWND window, UINT message, WPARAM w, LPARAM l, UINT_PTR id,
                                                DWORD_PTR) {
    if (message == WM_GETOBJECT && static_cast<LONG>(l) == UiaRootObjectId) {
        auto provider = new OverlayButtonProvider(window);
        auto result = UiaReturnRawElementProvider(window, w, l, provider);
        provider->Release();
        return result;
    }
    if (message == WM_NCDESTROY)
        RemoveWindowSubclass(window, overlay_button_subclass, id);
    return DefSubclassProc(window, message, w, l);
}
